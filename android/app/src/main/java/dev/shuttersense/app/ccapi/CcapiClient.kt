package dev.shuttersense.app.ccapi

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneId

// CCAPI client (Kotlin).
// Every call is routed through discovery (GET /ccapi), because which
// API version hosts an endpoint differs per camera model; when an endpoint
// exists under several versions the highest one wins. Mirrors ccapi/client.ts.
//
// Coverage: discovery, device information and status, the camera functions
// (/functions/*, /customfunction/*), every shooting setting (list, range and
// composite values, picture style detail, DELETE resets), shooting control
// (shutter, AF, focus drive, movie, zoom, flicker), live view (single
// frames, framed records with incidental info, streams read as they arrive),
// the optical-viewfinder AF APIs, events (polling in both versions,
// monitoring) and contents (browse, page, count, chunked lists, info, range
// downloads, modify, delete).

class CcapiException(val status: Int, message: String, val endpoint: String) : Exception(message)

/** A rejected setting change, worded so a model (or a person) can fix it. */
class SettingException(val setting: String, message: String) : Exception(message)

data class Endpoint(val version: String, val path: String, val get: Boolean, val post: Boolean, val put: Boolean, val delete: Boolean) {
    fun supports(method: String) = when (method) {
        "get" -> get
        "post" -> post
        "put" -> put
        "delete" -> delete
        else -> false
    }
}

class RawResponse(
    val status: Int,
    val contentType: String,
    val body: ByteArray,
    /** Response headers, names in lower case. */
    val headers: Map<String, String> = emptyMap(),
) {
    fun json(): JsonElement = if (body.isEmpty()) JsonObject(emptyMap()) else CcapiClient.json.parseToJsonElement(body.decodeToString())
    fun header(name: String): String? = headers[name.lowercase()]
}

/** A response whose body is read as it arrives (live view streams, event monitoring). */
class StreamResponse(val status: Int, val contentType: String, val body: InputStream)

/** Sends one HTTP request to the camera. */
fun interface CcapiTransport {
    suspend fun request(method: String, path: String, body: JsonElement?, headers: Map<String, String>): RawResponse

    /**
     * Opens a request whose answer is a stream and hands it to [read] while
     * it arrives; cancelling the coroutine ends the request. This default
     * buffers the whole answer first, which only suits cameras (or
     * simulators) that end their streams.
     */
    suspend fun <T> stream(method: String, path: String, read: suspend (StreamResponse) -> T): T {
        val res = request(method, path, null, emptyMap())
        return read(StreamResponse(res.status, res.contentType, ByteArrayInputStream(res.body)))
    }
}

class CcapiClient(private val transport: CcapiTransport) {
    companion object {
        val json = Json { ignoreUnknownKeys = true }
        private val SPLIT = Regex("""^/ccapi/(ver\d+)/(.+?)/?$""")
        private val VERSION = Regex("""^ver\d+$""")
        private val FILE_NAME = Regex("""\.[a-z0-9]{3,4}$""", RegexOption.IGNORE_CASE)
        private val JPEG_NAME = Regex("""\.jpe?g$""", RegexOption.IGNORE_CASE)
        private fun versionNumber(v: String) = v.removePrefix("ver").toIntOrNull() ?: 0

        /** JSON.stringify of a setting value, for messages. */
        fun quote(v: Any): String = when (v) {
            is String -> JsonPrimitive(v).toString()
            is Map<*, *>, is JsonElement -> toJson(v).toString()
            else -> v.toString()
        }

        /** Reduces an absolute URL (older cameras) to its path. */
        fun toPath(p: String): String =
            if (p.startsWith("http://") || p.startsWith("https://")) try {
                URI(p).path ?: p
            } catch (_: Exception) {
                p
            } else p
    }

    /** Endpoint key (path after the version) -> endpoints, highest version first. */
    private val endpoints = mutableMapOf<String, List<Endpoint>>()

    // ---------------------------------------------------------------- plumbing

    private fun failure(status: Int, body: ByteArray, path: String): CcapiException {
        var message = "HTTP $status"
        try {
            val m = (RawResponse(status, "", body).json() as? JsonObject)?.str("message")
            if (!m.isNullOrBlank()) message = m.trim()
        } catch (_: Exception) {
            // not JSON
        }
        return CcapiException(status, message, path)
    }

    private suspend fun call(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()): RawResponse {
        val res = transport.request(method, path, body, headers)
        if (res.status in 200..299) return res
        throw failure(res.status, res.body, path)
    }

    private suspend fun callJson(method: String, path: String, body: JsonElement? = null): JsonElement {
        val res = call(method, path, body)
        if (!res.contentType.contains("json") && res.body.isEmpty()) return JsonObject(emptyMap())
        return res.json()
    }

    private suspend fun callObject(method: String, path: String, body: JsonElement? = null): JsonObject =
        callJson(method, path, body) as? JsonObject ?: JsonObject(emptyMap())

    /** A GET whose answer is read while it arrives. */
    private suspend fun <T> stream(path: String, read: suspend (StreamResponse) -> T): T =
        transport.stream("GET", path) { res ->
            if (res.status !in 200..299) throw failure(res.status, res.body.readBytes(), path)
            read(res)
        }

    private fun body(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to toJson(v) })

    /** Reads the endpoint list. Activation-free cameras answer on topurlfordev instead of /ccapi. */
    suspend fun discover() {
        val data = try {
            callObject("GET", "/ccapi")
        } catch (e: CcapiException) {
            if (e.status != 404) throw e
            callObject("GET", "/ccapi/ver100/topurlfordev")
        }
        endpoints.clear()
        val found = mutableMapOf<String, MutableList<Endpoint>>()
        for ((version, list) in data) {
            if (!VERSION.matches(version) || list !is JsonArray) continue
            for (raw in list) {
                val o = raw as? JsonObject ?: continue
                // Older cameras list absolute URLs ("url"), newer ones paths ("path").
                var path = o.str("path")?.trim() ?: ""
                if (path.isEmpty()) {
                    val url = o.str("url") ?: continue
                    path = try {
                        URI(url).path ?: continue
                    } catch (_: Exception) {
                        continue
                    }
                }
                val m = SPLIT.matchEntire(path) ?: continue
                val (ver, key) = m.destructured
                fun flag(name: String) = (o[name] as? JsonPrimitive)?.booleanOrNull ?: false
                found.getOrPut(key) { mutableListOf() }
                    .add(Endpoint(ver, "/ccapi/$ver/$key", flag("get"), flag("post"), flag("put"), flag("delete")))
            }
        }
        for ((k, v) in found) endpoints[k] = v.sortedByDescending { versionNumber(it.version) }
        if (endpoints.isEmpty()) throw CcapiException(0, "The camera listed no API endpoints", "/ccapi")
    }

    /** The highest-version path for [key] that supports [method], or null. */
    fun endpoint(key: String, method: String = "get"): String? = endpoints[key]?.firstOrNull { it.supports(method) }?.path

    fun has(key: String, method: String = "get") = endpoint(key, method) != null

    /** Every discovered endpoint key (path after the version). */
    fun keys(): List<String> = endpoints.keys.toList()

    private fun need(key: String, method: String): String =
        endpoint(key, method) ?: throw CcapiException(404, "This camera has no ${method.uppercase()} $key", key)

    // ---------------------------------------------------------------- device

    suspend fun deviceInfo(): Map<String, String> {
        val d = callObject("GET", need("deviceinformation", "get")).mapValues { (it.value as? JsonPrimitive)?.contentOrNull ?: "" }
        // Accept the misspelt key "munufacturer" too.
        return if ("manufacturer" !in d && "munufacturer" in d) d + ("manufacturer" to d.getValue("munufacturer")) else d
    }

    /** Battery level as a short string ("full", "75%"), or null if unknown. */
    suspend fun battery(): String? {
        try {
            val list = batteries()
            val b = list.firstOrNull { it.position == "camera" } ?: list.firstOrNull()
            if (b != null) return if (b.level.isNotEmpty() && b.level.all { it.isDigit() }) "${b.level}%" else b.level
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // battery is informational only
        }
        return null
    }

    /** Every battery (body and grip): batterylist when offered, else the single battery as position "camera". */
    suspend fun batteries(): List<BatteryInfo> {
        fun parse(o: JsonObject, position: String? = null) =
            BatteryInfo(position ?: o.str("position") ?: "", o.str("name") ?: "", o.str("kind") ?: "", o.str("level") ?: "", o.str("quality") ?: "")
        if (has("devicestatus/batterylist")) {
            val list = (callObject("GET", need("devicestatus/batterylist", "get"))["batterylist"] as? JsonArray)?.mapNotNull { it as? JsonObject }
            if (!list.isNullOrEmpty()) return list.map { parse(it) }
        }
        return listOf(parse(callObject("GET", need("devicestatus/battery", "get")), "camera"))
    }

    suspend fun lens(): String? {
        if (!has("devicestatus/lens")) return null
        return try {
            val d = lensInfo()
            if (d.mount && d.name.isNotEmpty()) d.name else null
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    suspend fun lensInfo(): LensInfo {
        val d = callObject("GET", need("devicestatus/lens", "get"))
        return LensInfo(d.bool("mount") ?: false, d.str("name") ?: "")
    }

    /** normal, warning, frameratedown, disableliveview, disablerelease, … */
    suspend fun temperature(): String = callObject("GET", need("devicestatus/temperature", "get")).str("status") ?: ""

    suspend fun powerZoomStatus(): JsonObject = callObject("GET", need("devicestatus/powerzoomstatus", "get"))

    /** Mounted storages; empty when no card is in. */
    suspend fun storage(): List<StorageInfo> {
        val list = callObject("GET", need("devicestatus/storage", "get"))["storagelist"] as? JsonArray ?: return emptyList()
        return list.mapNotNull { it as? JsonObject }.map { s ->
            StorageInfo(
                s.str("name") ?: "", s.str("path") ?: s.str("url")?.let(::toPath) ?: "", s.str("accesscapability") ?: "",
                s.long("maxsize") ?: 0, s.long("spacesize") ?: 0, s.int("contentsnumber") ?: 0,
            )
        }
    }

    /** The storage new files go to (empty name and path without a card). */
    suspend fun currentStorage(): NamedPath = namedPath(callObject("GET", need("devicestatus/currentstorage", "get")))

    /** The folder new files go to. */
    suspend fun currentDirectory(): NamedPath = namedPath(callObject("GET", need("devicestatus/currentdirectory", "get")))

    private fun namedPath(o: JsonObject) = NamedPath(o.str("name") ?: "", o.str("path") ?: "")

    /** Step sizes the camera's custom functions use ("1/3", "1/2", …), keyed av, tv, exposure, flashexposure, iso. */
    suspend fun increments(): Map<String, String> {
        val out = linkedMapOf<String, String>()
        for (k in listOf("av", "tv", "exposure", "flashexposure")) {
            val p = endpoint("customfunction/exposureincrements/$k") ?: continue
            callObject("GET", p).str("value")?.let { out[k] = it }
        }
        endpoint("customfunction/isoincrements")?.let { p -> callObject("GET", p).str("value")?.let { out["iso"] = it } }
        return out
    }

    // ---------------------------------------------------------------- camera functions

    /** GET functions/<name> as the camera returns it. */
    suspend fun getFunction(name: String): JsonObject = callObject("GET", need("functions/$name", "get"))
    suspend fun putFunction(name: String, body: JsonElement): JsonObject = callObject("PUT", need("functions/$name", "put"), body)
    suspend fun postFunction(name: String, body: JsonElement): JsonObject = callObject("POST", need("functions/$name", "post"), body)
    suspend fun deleteFunction(name: String): JsonObject = callObject("DELETE", need("functions/$name", "delete"))

    /** A {value, ability} function such as beep, displayoff, autopoweroff, cors/corssetting, cardselection/stillimage. */
    suspend fun functionSetting(name: String): SettingItem =
        SettingItem.parse(getFunction(name)) ?: throw CcapiException(0, "Unexpected answer for $name", name)

    /** Changes a {value, ability} function after checking the value against its ability. */
    suspend fun setFunction(name: String, value: Any) {
        val path = need("functions/$name", "put")
        checkValue(name, value, functionSetting(name))
        try {
            call("PUT", path, body("value" to value))
        } catch (e: CcapiException) {
            throw SettingException(name, "$name = ${quote(value)} was refused by the camera (${e.message}).")
        }
    }

    suspend fun datetime(): CameraClock {
        val d = getFunction("datetime")
        return CameraClock(d.str("datetime") ?: "", d.bool("dst") ?: false)
    }

    /**
     * Sets the camera clock. [offsetMinutes] is the zone east of UTC (defaults
     * to this device's); with [dst] the wall-clock time already includes the shift.
     */
    suspend fun setDatetime(time: Instant, dst: Boolean = false, offsetMinutes: Int = ZoneId.systemDefault().rules.getOffset(time).totalSeconds / 60) {
        putFunction("datetime", body("datetime" to formatCameraDate(time, offsetMinutes), "dst" to dst))
    }

    /** Formats a card (all files, protected ones too, are erased). [name] as in storage(), e.g. "card1". */
    suspend fun formatCard(name: String) {
        postFunction("cardformat", body("name" to name))
    }

    /** [field]: copyright, author, ownername or nickname. */
    suspend fun registeredName(field: String): String = getFunction("registeredname/$field").str(field) ?: ""
    suspend fun setRegisteredName(field: String, value: String) {
        putFunction("registeredname/$field", body(field to value))
    }
    suspend fun clearRegisteredName(field: String) {
        deleteFunction("registeredname/$field")
    }

    /** Cleans the sensor; with [autoPowerOff] the camera switches off afterwards (the connection ends). */
    suspend fun sensorCleaning(autoPowerOff: Boolean) {
        postFunction("sensorcleaning", body("autopoweroff" to autoPowerOff))
    }

    /** Ends the Wi-Fi connection (202); the camera then has to be reconnected from its menu. */
    suspend fun wifiDisconnect() {
        postFunction("wificonnection", body("action" to "disconnect"))
    }

    /** Wired / multi-network bodies: "disconnect" or "reboot" the network function (202). */
    suspend fun networkConnection(action: String) {
        postFunction("networkconnection", body("action" to action))
    }

    /** Creates a folder ("" for the camera's default, or 5 of A-Z 0-9 _); it becomes the recording folder. */
    suspend fun createDirectory(name: String = "") {
        postFunction("directory/createdirectory", body("directoryname" to name))
    }

    /** The stored Wi-Fi settings (set1..set3). */
    suspend fun wifiSettings(): JsonObject = getFunction("wifisetting")
    suspend fun wifiSetting(set: String): JsonObject = getFunction("wifisetting/$set")
    suspend fun setWifiSetting(set: String, setting: Map<String, String>): JsonObject = putFunction("wifisetting/$set", toJson(setting))
    suspend fun deleteWifiSetting(set: String): JsonObject = deleteFunction("wifisetting/$set")

    /** The HTTPS root certificate (application/x-x509-user-cert). */
    suspend fun caCertificate(): ByteArray = call("GET", need("functions/ssl/cacert", "get")).body

    // ---------------------------------------------------------------- settings

    /** All shooting settings, merging every version's bulk list (higher versions win). */
    suspend fun settings(): Settings {
        val out = linkedMapOf<String, SettingItem>()
        val versions = (endpoints["shooting/settings"] ?: emptyList()).filter { it.get }.reversed() // low -> high
        for (ep in versions) {
            for ((k, v) in callObject("GET", ep.path)) SettingItem.parse(v)?.let { out[k] = it }
        }
        // The mode lives outside the bulk list on some models.
        for (key in listOf("shootingmode", "shootingmodedial")) {
            val p = endpoint("shooting/settings/$key", "get") ?: continue
            val cur = out[key]
            if (cur == null || (cur.text ?: "") == "") {
                try {
                    SettingItem.parse(callObject("GET", p))?.let { out[key] = it }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // not available in this state
                }
            }
        }
        return out
    }

    /**
     * The endpoint key of a setting. Accepts the path form ("picturestyle/auto")
     * and the bulk-list form ("picturestyle_auto").
     */
    fun settingKey(name: String): String {
        if ("shooting/settings/$name" in endpoints) return name
        val slashed = name.replace('_', '/')
        return if ("shooting/settings/$slashed" in endpoints) slashed else name
    }

    suspend fun setting(name: String): SettingItem =
        SettingItem.parse(callObject("GET", need("shooting/settings/${settingKey(name)}", "get")))
            ?: throw CcapiException(0, "Unexpected answer for $name", name)

    /** A composite setting (wbshift, stillimagequality, picturestyle/<style>, powerzoom); see [SettingItem.fields]. */
    suspend fun compositeSetting(name: String): SettingItem = setting(name)

    /**
     * Changes one setting after checking the value against what the camera
     * says it accepts right now, so a mistake comes back as a precise message.
     * [value] is a String, an Int for range settings such as colortemperature,
     * or a Map of every field for composite settings (see [setFields] for
     * partial changes).
     */
    suspend fun set(name: String, value: Any, current: SettingItem? = null) {
        if (name == "shootingmode" || name == "shootingmodedial") return setMode(value.toString())
        val key = settingKey(name)
        val path = endpoint("shooting/settings/$key", "put") ?: throw SettingException(name, "$name can't be changed on this camera.")
        val item = current ?: setting(key)
        checkValue(name, value, item)
        try {
            call("PUT", path, body("value" to value))
        } catch (e: CcapiException) {
            throw SettingException(name, "$name = ${quote(value)} was refused by the camera (${e.message}).")
        }
    }

    /** Changes some fields of a composite setting, keeping the others. */
    suspend fun setFields(name: String, changes: Map<String, Any>) {
        val item = compositeSetting(name)
        val ab = item.ability as? Ability.Composite
        val value = linkedMapOf<String, Any>()
        for ((k, v) in item.fields) {
            // Fields with an empty list are read-only (the base of a user style).
            val fab = ab?.fields?.get(k)
            if (fab is Ability.Options && fab.values.isEmpty()) continue
            if (v != null) value[k] = v
        }
        set(name, value + changes, item)
    }

    /** DELETE on a setting: the picture style details go back to their defaults. Returns the new value. */
    suspend fun resetSetting(name: String): JsonElement =
        callObject("DELETE", need("shooting/settings/${settingKey(name)}", "delete"))["value"] ?: JsonNull

    /** Picture style detail: sharpness_strength/_fineness/_threshold, contrast, saturation, colortone (or filtereffect/toningeffect). */
    suspend fun pictureStyleDetail(style: String): SettingItem = compositeSetting("picturestyle/$style")
    suspend fun setPictureStyleDetail(style: String, changes: Map<String, Any>) = setFields("picturestyle/$style", changes)

    /** White balance shift: [ba] = blue (-) / amber (+), [mg] = magenta (-) / green (+). */
    suspend fun setWbShift(ba: Int, mg: Int) = set("wbshift", mapOf("ba" to ba, "mg" to mg))

    /** Still image quality: raw (none/raw/craw) and jpeg size (or heif); leave one null to keep it. */
    suspend fun setStillImageQuality(raw: String? = null, jpeg: String? = null, heif: String? = null) {
        val changes = listOfNotNull(raw?.let { "raw" to it }, jpeg?.let { "jpeg" to it }, heif?.let { "heif" to it }).toMap()
        setFields("stillimagequality", changes)
    }

    /**
     * Changes the shooting mode. Cameras with a physical mode dial only accept
     * this after "ignore shooting mode dial" is switched on.
     */
    suspend fun setMode(mode: String) {
        val path = endpoint("shooting/settings/shootingmode", "put") ?: endpoint("shooting/settings/shootingmodedial", "put")
            ?: throw SettingException("shootingmode", "The shooting mode is set by the camera's mode dial and can't be changed remotely.")
        val item = SettingItem.parse(callObject("GET", path))
        val ab = item?.ability
        if (ab is Ability.Options && ab.values.isNotEmpty() && mode !in ab.values) {
            throw SettingException("shootingmode", "shootingmode \"$mode\" is not available. Options: ${ab.values.joinToString(", ")}.")
        }
        val req = body("value" to mode)
        try {
            call("PUT", path, req)
        } catch (e: CcapiException) {
            val ignore = endpoint("shooting/control/ignoreshootingmodedialmode", "post")
            if (e.status != 503 || ignore == null) {
                throw SettingException("shootingmode", "The camera refused shootingmode \"$mode\" (${e.message}).")
            }
            call("POST", ignore, body("action" to "on"))
            try {
                call("PUT", path, req)
            } catch (e2: CcapiException) {
                throw SettingException("shootingmode", "The camera refused shootingmode \"$mode\" (${e2.message}).")
            }
        }
    }

    /** Software override of the mode dial on or off. */
    suspend fun ignoreModeDial(on: Boolean) {
        call("POST", need("shooting/control/ignoreshootingmodedialmode", "post"), body("action" to if (on) "on" else "off"))
    }

    suspend fun ignoreModeDialStatus(): Boolean =
        callObject("GET", need("shooting/control/ignoreshootingmodedialmode", "get")).str("status") == "on"

    suspend fun recordable(): Recordable {
        val d = callObject("GET", need("shooting/information/recordable", "get"))
        return Recordable(d.int("recordableshots"), d.int("remainingtime"))
    }

    // ---------------------------------------------------------------- shooting control

    /**
     * One press of the shutter, with or without autofocus. A camera still
     * writing a burst answers "Device busy"; that press is retried until the
     * buffer clears (up to [busyWaitMs]). Without the one-shot endpoint it is a
     * full press and a release on the manual button, each retried on its own,
     * so a busy release can't take a second picture. Cancelling stops the
     * retries of a press that hasn't happened; once pressed, the release is
     * always sent, so a burst or bulb can't stay held.
     */
    suspend fun shutter(af: Boolean, busyWaitMs: Long = 15_000) {
        val path = endpoint("shooting/control/shutterbutton", "post")
        if (path != null) return whileBusy(busyWaitMs) { call("POST", path, body("af" to af)) }
        val manual = need("shooting/control/shutterbutton/manual", "post")
        whileBusy(busyWaitMs) { call("POST", manual, body("action" to "full_press", "af" to af)) }
        withContext(NonCancellable) {
            whileBusy(busyWaitMs) { call("POST", manual, body("action" to "release", "af" to false)) }
        }
    }

    /** Runs [fn], again every 300 ms while the camera answers "Device busy", for up to [waitMs]. */
    private suspend fun whileBusy(waitMs: Long, fn: suspend () -> Unit) {
        val until = System.currentTimeMillis() + waitMs
        while (true) {
            try {
                return fn()
            } catch (e: CcapiException) {
                if (e.status != 503 || !e.message.orEmpty().contains("busy", ignoreCase = true) || System.currentTimeMillis() >= until) throw e
                delay(300)
            }
        }
    }

    /** The shutter button by hand: half_press (AF/metering), full_press (holds: bursts, bulb), release. */
    suspend fun shutterButton(action: String, af: Boolean = false) {
        call("POST", need("shooting/control/shutterbutton/manual", "post"), body("action" to action, "af" to af))
    }

    /** AF without shooting ("start" / "stop"); the result shows in the live view AF frame status. */
    suspend fun autofocus(action: String) {
        call("POST", need("shooting/control/af", "post"), body("action" to action))
    }

    /** Moves focus closer (near1..near3) or further (far1..far3); 1 = small step, 3 = large. */
    suspend fun driveFocus(step: String) {
        call("POST", need("shooting/control/drivefocus", "post"), body("value" to step))
    }

    suspend fun movieMode(): Boolean = callObject("GET", need("shooting/control/moviemode", "get")).str("status") == "on"
    suspend fun setMovieMode(on: Boolean) {
        call("POST", need("shooting/control/moviemode", "post"), body("action" to if (on) "on" else "off"))
    }

    /** Starts or stops movie recording (movie mode must be on). */
    suspend fun record(action: String) {
        call("POST", need("shooting/control/recbutton", "post"), body("action" to action))
    }

    /** Optical zoom position (PowerShot models). */
    suspend fun zoom(): SettingItem =
        SettingItem.parse(callObject("GET", need("shooting/control/zoom", "get"))) ?: throw CcapiException(0, "Unexpected answer for zoom", "zoom")

    suspend fun setZoom(value: Int) {
        checkValue("zoom", value, zoom())
        call("POST", need("shooting/control/zoom", "post"), body("value" to value))
    }

    /** Power zoom (adapter or PZ lens): state, and driving "wide" / "tele" / "stop". */
    suspend fun powerZoom(): SettingItem =
        SettingItem.parse(callObject("GET", need("shooting/control/powerzoom", "get"))) ?: throw CcapiException(0, "Unexpected answer for powerzoom", "powerzoom")

    suspend fun drivePowerZoom(value: String) {
        call("POST", need("shooting/control/powerzoom", "post"), body("value" to value))
    }

    /** Mains flicker detection: "ok" = flicker found, "ng" = none. */
    suspend fun flickerDetection(): String = detectFlicker().str("result") ?: ""

    /** Mains flicker detection with the frequency the camera found ("100Hz" / "120Hz"), when it found one. */
    suspend fun detectFlicker(): JsonObject =
        callObject("POST", need("shooting/control/flickerdetection", "post"), body("action" to "start"))

    /** High-frequency flicker detection ("start" / "cancel"); with [applyResult] the camera takes the recommended Tv. */
    suspend fun hfFlickerDetection(action: String, applyResult: Boolean = true): JsonObject =
        callObject("POST", need("shooting/control/hfflickerdetection", "post"), body("action" to action, "apply_result" to applyResult))

    /** Nudges the HF flicker shutter speed while the detection result is shown (decrement_large … increment_large). */
    suspend fun stepHfFlickerTv(value: String) {
        call("POST", need("shooting/control/hfflickertv", "post"), body("value" to value))
    }

    // ---------------------------------------------------------------- live view

    /** [size] "small" or "medium"; [display] "on", "off" or "keep" for the camera's own screen. */
    suspend fun startLiveView(size: String = "small", display: String = "on") {
        call("POST", need("shooting/liveview", "post"), body("liveviewsize" to size, "cameradisplay" to display))
    }

    suspend fun stopLiveView(display: String = "keep") {
        call("POST", need("shooting/liveview", "post"), body("liveviewsize" to "off", "cameradisplay" to display))
    }

    /** Retries the first frames after starting live view, starting it if needed. */
    private suspend fun <T> liveRetry(fn: suspend () -> T): T {
        var attempt = 0
        while (true) {
            try {
                return fn()
            } catch (e: CcapiException) {
                if (e.status != 503 || attempt >= 4) throw e
                if (e.message?.contains("not started", ignoreCase = true) == true) startLiveView()
                delay(250L * (attempt + 1))
            }
            attempt++
        }
    }

    /** One live-view JPEG. Starts live view if needed; the first frames after starting may not be ready. */
    suspend fun liveFrame(): ByteArray {
        val path = need("shooting/liveview/flip", "get")
        return liveRetry { call("GET", path).body }
    }

    /** A live-view frame and/or its incidental information ([kind] "image", "info" or "both"). */
    suspend fun liveDetail(kind: String = "both"): LiveDetail = liveDetailFrames(kind).firstOrNull() ?: LiveDetail()

    /** One live-view frame together with its incidental information, in whichever order the camera sends them. */
    suspend fun liveFrameWithInfo(): LiveDetail {
        val frames = liveDetailFrames("both")
        return LiveDetail(frames.firstNotNullOfOrNull { it.image }, frames.firstNotNullOfOrNull { it.info })
    }

    private suspend fun liveDetailFrames(kind: String): List<LiveDetail> {
        val path = need("shooting/liveview/flipdetail", "get")
        return detailFrames(parseRecords(liveRetry { call("GET", "$path?kind=$kind").body }))
    }

    private fun streamPath(kind: String, detail: String): String {
        val path = need("shooting/liveview/$kind", "get")
        return if (kind == "scrolldetail") "$path?kind=$detail" else path
    }

    /**
     * Reads one of the continuous streams (scroll, scrolldetail, multipart)
     * to its end and returns the frames it delivered. This only suits
     * cameras (or simulators) that end the stream; a real camera streams
     * until stopLiveStream(), so use [liveFrames] there.
     */
    suspend fun liveStream(kind: String, detail: String = "image"): List<LiveDetail> {
        val res = call("GET", streamPath(kind, detail))
        return when (kind) {
            "scrolldetail" -> detailFrames(parseRecords(res.body))
            "multipart" -> parseMultipart(res.body, multipartBoundary(res.contentType)).map { LiveDetail(image = it) }
            else -> splitJpegs(res.body).map { LiveDetail(image = it) }
        }
    }

    /**
     * The same streams, frame by frame as they arrive. A frame is complete
     * once its picture is in ("image", "both") or its information ("info").
     * Cancelling the collection closes the connection; the camera may still
     * need stopLiveStream() before it streams again.
     */
    fun liveFrames(kind: String, detail: String = "image"): Flow<LiveDetail> = channelFlow {
        stream(streamPath(kind, detail)) { res ->
            when (kind) {
                "scrolldetail" -> sendDetailFrames(RecordReader(res.body), detail)
                "multipart" -> {
                    val r = MultipartReader(res.body, multipartBoundary(res.contentType))
                    while (true) send(LiveDetail(image = r.next() ?: break))
                }
                else -> {
                    val r = JpegSplitter(res.body)
                    while (true) send(LiveDetail(image = r.next() ?: break))
                }
            }
        }
    }

    private suspend fun ProducerScope<LiveDetail>.sendDetailFrames(r: RecordReader, detail: String) {
        var info: LiveViewInfo? = null
        while (true) {
            val rec = r.next() ?: break
            when (rec.type) {
                RECORD_INFO -> {
                    val parsed = LiveViewInfo(parseObject(rec.data))
                    if (detail == "info") send(LiveDetail(info = parsed)) else info = parsed
                }
                RECORD_JPEG -> {
                    send(LiveDetail(rec.data, info))
                    info = null
                }
            }
        }
        val rest = info
        if (rest != null) send(LiveDetail(info = rest))
    }

    suspend fun stopLiveStream(kind: String) {
        call("DELETE", need("shooting/liveview/$kind", "delete"))
    }

    /** Moves the AF frame (and the magnified area) to a point in still-image Large pixels. */
    suspend fun setAfFramePosition(x: Int, y: Int) {
        call("PUT", need("shooting/liveview/afframeposition", "put"), body("positionx" to x, "positiony" to y))
    }

    /** Custom white balance from the live view at a point (still-image Large pixels); WB becomes "custom". */
    suspend fun clickWhiteBalance(x: Int, y: Int) {
        call("POST", need("shooting/liveview/clickwb", "post"), body("positionx" to x, "positiony" to y))
    }

    /** Adds the electronic level to the incidental information. */
    suspend fun angleInformation(on: Boolean) {
        call("POST", need("shooting/liveview/angleinformation", "post"), body("action" to if (on) "start" else "stop"))
    }

    /** The SDP description of the RTP stream. */
    suspend fun rtpSessionDescription(): String = call("GET", need("shooting/liveview/rtpsessiondesc", "get")).body.decodeToString()

    /** Starts or stops ("start" / "stop") RTP streaming of movie live view to [ipAddress]. */
    suspend fun rtp(action: String, ipAddress: String) {
        call("POST", need("shooting/liveview/rtp", "post"), body("action" to action, "ipaddress" to ipAddress))
    }

    // ---------------------------------------------------------------- optical viewfinder AF

    /** afareaselectionmode, afareaselection, afframeinformation or afareainformation. */
    suspend fun opticalFinder(name: String): JsonObject = callObject("GET", need("shooting/opticalfinder/$name", "get"))

    /** [name]: afareaselectionmode or afareaselection. */
    suspend fun setOpticalFinder(name: String, value: String) {
        call("PUT", need("shooting/opticalfinder/$name", "put"), body("value" to value))
    }

    // ---------------------------------------------------------------- events

    /**
     * Changes since the last poll. ver110+ supports a long-poll timeout
     * ([wait] "immediately", "short" or "long"); ver100 returns immediately
     * with continue=off, or holds with continue=on. Pass a [version] to use
     * that one instead of the highest.
     */
    suspend fun poll(wait: String = "immediately", version: String? = null): JsonObject {
        val ep = endpoints["event/polling"]?.firstOrNull { it.get && (version == null || it.version == version) }
            ?: throw CcapiException(404, "This camera has no event polling", "event/polling")
        val q = if (versionNumber(ep.version) >= 110) "?timeout=$wait" else "?continue=${if (wait == "immediately") "off" else "on"}"
        return callObject("GET", ep.path + q)
    }

    /** Ends a waiting poll. */
    suspend fun stopPolling() {
        call("DELETE", need("event/polling", "delete"))
    }

    /** Reads the monitoring stream to its end: one event object per record (see [liveStream] about streams). */
    suspend fun monitor(): List<JsonObject> =
        parseRecords(call("GET", need("event/monitoring", "get")).body).filter { it.type == RECORD_EVENT }.map { parseObject(it.data) }

    /** The monitoring stream, event by event as the camera sends them; cancel the collection to close it. */
    fun monitorEvents(): Flow<JsonObject> = channelFlow {
        stream(need("event/monitoring", "get")) { res ->
            val r = RecordReader(res.body)
            while (true) {
                val rec = r.next() ?: break
                if (rec.type == RECORD_EVENT) send(parseObject(rec.data))
            }
        }
    }

    suspend fun stopMonitoring() {
        call("DELETE", need("event/monitoring", "delete"))
    }

    /** Waits for the next file the camera writes and returns its path (JPEG preferred). */
    suspend fun waitForNewFile(timeoutMs: Long = 15_000, onEvent: ((JsonObject) -> Unit)? = null): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        val longPoll = (endpoints["event/polling"] ?: emptyList()).any { versionNumber(it.version) >= 110 }
        while (System.currentTimeMillis() < deadline) {
            val ev = poll(if (longPoll) "short" else "immediately")
            onEvent?.invoke(ev)
            val added = (ev["addedcontents"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
            val files = added.map(::toPath).filter { FILE_NAME.containsMatchIn(it) }
            val jpeg = files.firstOrNull { JPEG_NAME.containsMatchIn(it) }
            if (jpeg != null) return jpeg
            if (files.isNotEmpty()) return files[0]
            if (!longPoll) delay(300)
        }
        throw CcapiException(504, "The camera didn't report a new photo in time", "event/polling")
    }

    // ---------------------------------------------------------------- contents

    /** The path list of a contents answer ({"path": [...]} or, from older cameras, {"url": [...]}). */
    private fun pathList(d: JsonElement): List<String> {
        val o = d as? JsonObject ?: return emptyList()
        val list = (o["path"] ?: o["url"]) as? JsonArray ?: return emptyList()
        return list.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.let(::toPath) }
    }

    private fun query(vararg pairs: Pair<String, String?>): String {
        val q = pairs.mapNotNull { (k, v) -> v?.let { "$k=${URLEncoder.encode(it, "UTF-8")}" } }.joinToString("&")
        return if (q.isEmpty()) "" else "?$q"
    }

    /** Storage paths, e.g. "/ccapi/ver120/contents/card1". */
    suspend fun storages(): List<String> = pathList(callJson("GET", need("contents", "get")))

    /** Folder paths on a storage. */
    suspend fun directories(storage: String): List<String> = pathList(callJson("GET", toPath(storage)))

    /** One page (100 entries, 1-based) of a folder, optionally one file [type] (jpeg, cr3, mp4, mov, hif, …). */
    suspend fun files(dir: String, type: String? = null, page: Int? = null): List<String> =
        pathList(callJson("GET", toPath(dir) + query("type" to type, "page" to page?.toString())))

    /** How many entries a folder holds, and in how many pages. */
    suspend fun contentsCount(dir: String, type: String? = null): ContentsCount {
        val d = callObject("GET", toPath(dir) + query("kind" to "number", "type" to type))
        return ContentsCount(d.int("contentsnumber") ?: 0, d.int("pagenumber") ?: 0)
    }

    /** Every entry of a folder, page by page. */
    suspend fun allFiles(dir: String, type: String? = null): List<String> {
        val pages = contentsCount(dir, type).pageNumber
        return (1..pages).flatMap { files(dir, type, it) }
    }

    /** Every entry of a folder in one chunked answer (a run of {"path": [...]} objects); [order] "asc" or "desc". */
    suspend fun filesChunked(dir: String, type: String? = null, order: String? = null): List<String> {
        val bytes = call("GET", toPath(dir) + query("kind" to "chunked", "type" to type, "order" to order)).body
        val out = mutableListOf<String>()
        for (obj in parseJsonSequence(bytes.decodeToString())) {
            (obj as? JsonObject)?.str("message")?.let { throw CcapiException(503, it.trim(), dir) }
            out.addAll(pathList(obj))
        }
        return out
    }

    suspend fun fileInfo(path: String): FileInfo = FileInfo.parse(callObject("GET", "${toPath(path)}?kind=info"))

    /** Downloads a file: a display-size JPEG when the camera offers one, else the original. [kind]: main, display, thumbnail, embedded. */
    suspend fun download(path: String, kind: String = "display"): ByteArray {
        val p = toPath(path)
        return try {
            call("GET", "$p?kind=$kind").body
        } catch (e: CcapiException) {
            if (e.status == 400 && kind != "main") call("GET", "$p?kind=main").body else throw e
        }
    }

    /** Part of a file ([end] inclusive; null for the rest). 416 when the range is outside the file. */
    suspend fun downloadRange(path: String, start: Long, end: Long? = null, kind: String = "main"): FilePart {
        val res = call("GET", "${toPath(path)}?kind=$kind", null, mapOf("Range" to "bytes=$start-${end ?: ""}"))
        val m = res.header("content-range")?.let { Regex("""bytes (\d+)-(\d+)/(\d+|\*)""").find(it) }
        if (m != null) {
            val (s, e, t) = m.destructured
            return FilePart(res.body, s.toLong(), e.toLong(), t.toLongOrNull())
        }
        // The whole file came back (no range support).
        val size = res.body.size.toLong()
        val last = minOf(size - 1, end ?: (size - 1))
        val part = if (start >= size) ByteArray(0) else res.body.copyOfRange(start.toInt(), (last + 1).toInt())
        return FilePart(part, start, last, size)
    }

    /** PUT on a file: [action] rotate ("0".."270"), protect / archive ("enable"/"disable"), rating ("off", "1".."5"), xmp_description. */
    suspend fun modifyFile(path: String, action: String, value: String) {
        call("PUT", toPath(path), body("action" to action, "value" to value))
    }
    suspend fun rotateFile(path: String, degrees: Int) = modifyFile(path, "rotate", degrees.toString())
    suspend fun protectFile(path: String, on: Boolean) = modifyFile(path, "protect", if (on) "enable" else "disable")
    suspend fun archiveFile(path: String, on: Boolean) = modifyFile(path, "archive", if (on) "enable" else "disable")

    /** [rating] 1..5, or 0 for none ("off"). */
    suspend fun rateFile(path: String, rating: Int) = modifyFile(path, "rating", if (rating == 0) "off" else rating.toString())

    /** Writes GPS data into a file (rationals as [numerator, denominator]). */
    suspend fun setFileGps(path: String, gps: JsonObject) {
        call("PUT", toPath(path), buildJsonObject {
            put("action", "gps")
            put("gps", gps)
        })
    }

    /** Deletes a file (409 "File protected" for protected ones). */
    suspend fun deleteFile(path: String) {
        call("DELETE", toPath(path))
    }

    /** Deletes a folder and its files; protected files stay (409 "Partial deletion"). */
    suspend fun deleteDirectory(path: String) {
        call("DELETE", toPath(path))
    }
}
