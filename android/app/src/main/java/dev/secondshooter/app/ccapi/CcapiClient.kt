package dev.secondshooter.app.ccapi

import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.net.URI

// CCAPI client (Kotlin).
// Every call is routed through discovery (GET /ccapi), because which
// API version hosts an endpoint differs per camera model; when an endpoint
// exists under several versions the highest one wins. Mirrors ccapi/client.ts.

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

sealed class Ability {
    data class Options(val values: List<String>) : Ability()
    data class Range(val min: Int?, val max: Int?, val step: Int?) : Ability()

    fun toJson(): JsonElement = when (this) {
        is Options -> JsonArray(values.map { JsonPrimitive(it) })
        is Range -> buildJsonObject {
            put("min", min)
            put("max", max)
            put("step", step)
        }
    }
}

data class SettingItem(val value: JsonElement, val ability: Ability) {
    /** The value as a string ("" when the mode doesn't use it), or null. */
    val text: String? get() = (value as? JsonPrimitive)?.contentOrNull

    val changeable: Boolean
        get() = when (ability) {
            is Ability.Options -> ability.values.isNotEmpty()
            is Ability.Range -> ability.min != null && ability.max != null
        }

    companion object {
        fun parse(e: JsonElement?): SettingItem? {
            val o = e as? JsonObject ?: return null
            val value = o["value"] ?: JsonNull
            val ab = o["ability"]
            val ability = when (ab) {
                is JsonArray -> Ability.Options(ab.mapNotNull { (it as? JsonPrimitive)?.contentOrNull })
                is JsonObject -> Ability.Range(
                    (ab["min"] as? JsonPrimitive)?.intOrNull,
                    (ab["max"] as? JsonPrimitive)?.intOrNull,
                    (ab["step"] as? JsonPrimitive)?.intOrNull,
                )
                else -> Ability.Options(emptyList())
            }
            return SettingItem(value, ability)
        }
    }
}

typealias Settings = Map<String, SettingItem>

class RawResponse(val status: Int, val contentType: String, val body: ByteArray) {
    fun json(): JsonElement = if (body.isEmpty()) JsonObject(emptyMap()) else CcapiClient.json.parseToJsonElement(body.decodeToString())
}

/** Sends one HTTP request to the camera. */
fun interface CcapiTransport {
    suspend fun request(method: String, path: String, body: JsonElement?): RawResponse
}

class CcapiClient(private val transport: CcapiTransport) {
    companion object {
        val json = Json { ignoreUnknownKeys = true }
        private val SPLIT = Regex("""^/ccapi/(ver\d+)/(.+?)/?$""")
        private val VERSION = Regex("""^ver\d+$""")
        private fun versionNumber(v: String) = v.removePrefix("ver").toIntOrNull() ?: 0

        /** JSON.stringify of a setting value, for messages. */
        fun quote(v: Any): String = if (v is String) JsonPrimitive(v).toString() else v.toString()
    }

    /** Endpoint key (path after the version) -> endpoints, highest version first. */
    private val endpoints = mutableMapOf<String, List<Endpoint>>()

    // ---------------------------------------------------------------- plumbing

    private suspend fun call(method: String, path: String, body: JsonElement? = null): RawResponse {
        val res = transport.request(method, path, body)
        if (res.status in 200..299) return res
        var message = "HTTP ${res.status}"
        try {
            val m = (res.json() as? JsonObject)?.get("message")?.let { (it as? JsonPrimitive)?.contentOrNull }
            if (!m.isNullOrBlank()) message = m.trim()
        } catch (_: Exception) {
            // not JSON
        }
        throw CcapiException(res.status, message, path)
    }

    private suspend fun callJson(method: String, path: String, body: JsonElement? = null): JsonElement {
        val res = call(method, path, body)
        if (!res.contentType.contains("json") && res.body.isEmpty()) return JsonObject(emptyMap())
        return res.json()
    }

    private suspend fun callObject(method: String, path: String, body: JsonElement? = null): JsonObject =
        callJson(method, path, body) as? JsonObject ?: JsonObject(emptyMap())

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
                var path = (o["path"] as? JsonPrimitive)?.contentOrNull ?: ""
                if (path.isEmpty()) {
                    val url = (o["url"] as? JsonPrimitive)?.contentOrNull ?: continue
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

    private fun need(key: String, method: String): String =
        endpoint(key, method) ?: throw CcapiException(404, "This camera has no ${method.uppercase()} $key", key)

    // ---------------------------------------------------------------- device

    suspend fun deviceInfo(): Map<String, String> =
        callObject("GET", need("deviceinformation", "get")).mapValues { (it.value as? JsonPrimitive)?.contentOrNull ?: "" }

    /** Battery level as a short string ("full", "75%"), or null if unknown. */
    suspend fun battery(): String? {
        try {
            if (has("devicestatus/batterylist")) {
                val list = (callObject("GET", need("devicestatus/batterylist", "get"))["batterylist"] as? JsonArray)?.mapNotNull { it as? JsonObject }
                val b = list?.firstOrNull { it.str("position") == "camera" } ?: list?.firstOrNull()
                if (b != null) {
                    val level = b.str("level") ?: return null
                    return if (level.all { it.isDigit() } && level.isNotEmpty()) "$level%" else level
                }
            }
            if (has("devicestatus/battery")) return callObject("GET", need("devicestatus/battery", "get")).str("level")
        } catch (_: Exception) {
            // battery is informational only
        }
        return null
    }

    suspend fun lens(): String? {
        if (!has("devicestatus/lens")) return null
        return try {
            val d = callObject("GET", need("devicestatus/lens", "get"))
            val mount = (d["mount"] as? JsonPrimitive)?.booleanOrNull ?: false
            val name = d.str("name")
            if (mount && !name.isNullOrEmpty()) name else null
        } catch (_: Exception) {
            null
        }
    }

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
                } catch (_: Exception) {
                    // not available in this state
                }
            }
        }
        return out
    }

    suspend fun setting(name: String): SettingItem =
        SettingItem.parse(callObject("GET", need("shooting/settings/$name", "get")))
            ?: throw CcapiException(0, "Unexpected answer for $name", name)

    /**
     * Changes one setting after checking the value against what the camera
     * says it accepts right now, so a mistake comes back as a precise message.
     * [value] is a String, or an Int for range settings such as colortemperature.
     */
    suspend fun set(name: String, value: Any, current: SettingItem? = null) {
        if (name == "shootingmode" || name == "shootingmodedial") return setMode(value.toString())
        val path = endpoint("shooting/settings/$name", "put") ?: throw SettingException(name, "$name can't be changed on this camera.")
        val item = current ?: setting(name)
        checkValue(name, value, item)
        try {
            call("PUT", path, buildJsonObject { putValue(value) })
        } catch (e: CcapiException) {
            throw SettingException(name, "$name = ${quote(value)} was refused by the camera (${e.message}).")
        }
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
        val body = buildJsonObject { put("value", mode) }
        try {
            call("PUT", path, body)
        } catch (e: CcapiException) {
            val ignore = endpoint("shooting/control/ignoreshootingmodedialmode", "post")
            if (e.status != 503 || ignore == null) {
                throw SettingException("shootingmode", "The camera refused shootingmode \"$mode\" (${e.message}).")
            }
            call("POST", ignore, buildJsonObject { put("action", "on") })
            try {
                call("PUT", path, body)
            } catch (e2: CcapiException) {
                throw SettingException("shootingmode", "The camera refused shootingmode \"$mode\" (${e2.message}).")
            }
        }
    }

    // ---------------------------------------------------------------- live view and shooting

    suspend fun startLiveView(size: String = "small") {
        call("POST", need("shooting/liveview", "post"), buildJsonObject {
            put("liveviewsize", size)
            put("cameradisplay", "on")
        })
    }

    /** One live-view JPEG. Starts live view if needed; the first frames after starting may not be ready. */
    suspend fun liveFrame(): ByteArray {
        val path = need("shooting/liveview/flip", "get")
        var attempt = 0
        while (true) {
            try {
                return call("GET", path).body
            } catch (e: CcapiException) {
                if (e.status != 503 || attempt >= 4) throw e
                if (e.message?.contains("not started", ignoreCase = true) == true) startLiveView()
                delay(250L * (attempt + 1))
            }
            attempt++
        }
    }

    /** Full press and release, with or without autofocus. */
    suspend fun shutter(af: Boolean) {
        val path = endpoint("shooting/control/shutterbutton", "post")
        if (path != null) {
            call("POST", path, buildJsonObject { put("af", af) })
            return
        }
        val manual = need("shooting/control/shutterbutton/manual", "post")
        call("POST", manual, buildJsonObject {
            put("action", "full_press")
            put("af", af)
        })
        call("POST", manual, buildJsonObject {
            put("action", "release")
            put("af", false)
        })
    }

    private fun pollingEndpoint(): Endpoint? = endpoints["event/polling"]?.firstOrNull { it.get }

    /**
     * Changes since the last poll. ver110+ supports a long-poll timeout; ver100
     * returns immediately with continue=off.
     */
    suspend fun poll(wait: String = "immediately"): JsonObject {
        val ep = pollingEndpoint() ?: throw CcapiException(404, "This camera has no event polling", "event/polling")
        val q = if (versionNumber(ep.version) >= 110) "?timeout=$wait" else "?continue=off"
        return callObject("GET", ep.path + q)
    }

    /** Waits for the next file the camera writes and returns its path (JPEG preferred). */
    suspend fun waitForNewFile(timeoutMs: Long = 15_000, onEvent: ((JsonObject) -> Unit)? = null): String {
        val deadline = System.currentTimeMillis() + timeoutMs
        val longPoll = (endpoints["event/polling"] ?: emptyList()).any { versionNumber(it.version) >= 110 }
        while (System.currentTimeMillis() < deadline) {
            val ev = poll(if (longPoll) "short" else "immediately")
            onEvent?.invoke(ev)
            val added = (ev["addedcontents"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
            val files = added.map(::toPath).filter { Regex("""\.[a-z0-9]{3,4}$""", RegexOption.IGNORE_CASE).containsMatchIn(it) }
            val jpeg = files.firstOrNull { Regex("""\.jpe?g$""", RegexOption.IGNORE_CASE).containsMatchIn(it) }
            if (jpeg != null) return jpeg
            if (files.isNotEmpty()) return files[0]
            if (!longPoll) delay(300)
        }
        throw CcapiException(504, "The camera didn't report a new photo in time", "event/polling")
    }

    /** Downloads a file: a display-size JPEG when the camera offers one, else the original. */
    suspend fun download(path: String, kind: String = "display"): ByteArray {
        return try {
            call("GET", "$path?kind=$kind").body
        } catch (e: CcapiException) {
            if (e.status == 400 && kind != "main") call("GET", "$path?kind=main").body else throw e
        }
    }

    private fun toPath(p: String): String =
        if (p.startsWith("http://") || p.startsWith("https://")) try {
            URI(p).path ?: p
        } catch (_: Exception) {
            p
        } else p
}

/** Validates a value against an ability, with messages that list what would work. */
fun checkValue(name: String, value: Any, item: SettingItem) {
    when (val ab = item.ability) {
        is Ability.Options -> {
            if (ab.values.isEmpty()) throw SettingException(name, "$name can't be changed in the current shooting mode.")
            if (value !is String || value !in ab.values) {
                val shown = if (ab.values.size > 40) ab.values.take(40).joinToString(", ") + ", …" else ab.values.joinToString(", ")
                throw SettingException(name, "$name = ${CcapiClient.quote(value)} is not accepted. Options: $shown.")
            }
        }
        is Ability.Range -> {
            val min = ab.min
            val max = ab.max
            if (min == null || max == null) throw SettingException(name, "$name can't be changed in the current shooting mode.")
            val step = ab.step?.takeIf { it != 0 } ?: 1
            if (value !is Int || value < min || value > max || (value - min) % step != 0) {
                throw SettingException(name, "$name must be a whole number from $min to $max in steps of $step.")
            }
        }
    }
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun kotlinx.serialization.json.JsonObjectBuilder.putValue(value: Any) {
    when (value) {
        is Int -> put("value", value)
        is Long -> put("value", value)
        is Number -> put("value", value)
        is Boolean -> put("value", value)
        else -> put("value", value.toString())
    }
}
