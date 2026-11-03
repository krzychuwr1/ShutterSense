package dev.shuttersense.app.agent

import dev.shuttersense.app.ccapi.Ability
import dev.shuttersense.app.ccapi.CameraValues
import dev.shuttersense.app.ccapi.CcapiClient
import dev.shuttersense.app.ccapi.CcapiException
import dev.shuttersense.app.ccapi.SettingException
import dev.shuttersense.app.ccapi.SettingItem
import dev.shuttersense.app.ccapi.Settings
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import dev.shuttersense.app.glasses.IDEA_IMAGE_BYTES
import java.util.Base64
import kotlin.math.roundToInt

// The agent's camera tools on the CCAPI client: what get_camera_state, look,
// set_settings and shoot do, and what the model gets back. A port of
// agent/camera-tools.ts; keep the two in step.

/** Settings the agent may change. Never storage, formats, network or power. */
val AGENT_SETTINGS = listOf(
    "shootingmode", "av", "tv", "iso", "exposure", "wb", "colortemperature",
    "metering", "afoperation", "afmethod", "drive", "picturestyle",
    "flash", "shuttermode", "trackingsetting", "stillimageaspectratio", "wbshift",
    "antiflickershoot", "hfantiflickershoot", "hfflickertv",
)

/** Picture style fine-tuning the agent may change (on the current style). */
val STYLE_DETAIL_FIELDS = listOf("contrast", "saturation", "sharpness_strength", "colortone")

/**
 * Set first, with a refresh after each: the mode, shutter type and ISO change
 * which other settings are available (flash needs the mechanical shutter),
 * and the picture style decides which style style_detail fine-tunes.
 */
private val LEADING_SETTINGS = listOf("shootingmode", "shuttermode", "iso", "picturestyle")

/** Settings a mode can hand over to the camera, so "unchangeable" means "the camera picks it". */
private val EXPOSURE_KEYS = listOf("av", "tv", "iso", "exposure")

/** The camera-chosen exposure values (effective_value_*) an event reports. */
private fun effectiveValues(ev: JsonObject): Map<String, String> = EXPOSURE_KEYS.mapNotNull { k ->
    val v = ((ev["effective_value_$k"] as? JsonObject)?.get("value") as? JsonPrimitive)
    if (v != null && v.isString && v.content.isNotEmpty()) k to v.content else null
}.toMap()

/** Long side of images sent to the model. */
const val MODEL_IMAGE_SIDE = 768
private const val THUMB_SIDE = 320

class ShotResult(
    val n: Int,
    val jpeg: ByteArray,
    val image: PreparedImage,
    val thumb: String,
    /** "Av · f/2.8 · 1/1000 s · ISO 1600". */
    val exposure: String,
    val settings: Settings,
)

class CameraTools(val client: CcapiClient, private val images: ImageTools) {
    /** Values the camera picked in auto modes, from event polling. */
    private val effective = mutableMapOf<String, String>()
    private var model = "Camera"
    private var lensName: String? = null
    var settings: Settings = emptyMap()
        private set

    suspend fun connect(): String {
        client.discover()
        try {
            client.deviceInfo()["productname"]?.takeIf { it.isNotEmpty() }?.let { model = it }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // optional
        }
        lensName = client.lens()
        drainEvents()
        settings = client.settings()
        return describe()
    }

    fun describe() = lensName?.let { "$model, lens $it" } ?: model

    /** The camera's product name, and the mounted lens (null when none is reported). */
    val modelName: String get() = model
    val lens: String? get() = lensName

    /** The value the camera picked for [key] (av, tv, iso, exposure) in a mode that chooses it, from event polling. */
    fun cameraChosen(key: String): String? = effective[key]

    private fun absorb(ev: JsonObject) {
        effective.putAll(effectiveValues(ev))
    }

    /** Reads pending events so later waits only see new ones. */
    suspend fun drainEvents() {
        try {
            absorb(client.poll("immediately"))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // cameras without polling still work, minus effective values
        }
    }

    suspend fun refresh(): Settings {
        drainEvents()
        settings = client.settings()
        return settings
    }

    /**
     * "Av · f/2.8 · 1/1000 s · ISO 1600 (auto) · +1 EV", using camera-chosen values where
     * the mode picks them. [used] holds what a shot reported it actually used (flash caps
     * the shutter at the sync speed, say), which wins.
     */
    fun exposureLine(s: Settings = settings, used: Map<String, String> = emptyMap()): String {
        fun v(k: String): String {
            used[k]?.let { return it }
            val own = s[k]?.text
            return if (!own.isNullOrEmpty()) own else effective[k] ?: ""
        }
        val mode = s["shootingmode"]?.text?.takeIf { it.isNotEmpty() } ?: s["shootingmodedial"]?.text ?: ""
        // With high-frequency anti-flicker on, Tv and M shoot at its matched speed, not the Tv setting.
        val hfTv = if (s["hfantiflickershoot"]?.text == "enable" && (mode == "tv" || mode == "m")) s["hfflickertv"]?.text.orEmpty() else ""
        val parts = mutableListOf(
            CameraValues.prettyValue("shootingmode", mode),
            CameraValues.prettyValue("av", v("av")),
            CameraValues.prettyValue("tv", used["tv"] ?: hfTv.ifEmpty { v("tv") }),
        )
        val autoIso = if (s["iso"]?.text == "auto") used["iso"] ?: effective["iso"] else null
        val iso = if (autoIso != null) "ISO $autoIso (auto)" else CameraValues.prettyValue("iso", v("iso"))
        parts.add(iso)
        val ev = s["exposure"]?.text
        if (!ev.isNullOrEmpty() && ev != "+0.0") parts.add(CameraValues.prettyValue("exposure", ev))
        return parts.filter { it.isNotEmpty() && it != "–" }.joinToString(" · ")
    }

    // ---------------------------------------------------------------- tools

    suspend fun getState(): String {
        val s = refresh()
        val out = linkedMapOf<String, JsonElement>()
        for (key in AGENT_SETTINGS) {
            val item = (if (key == "shootingmode") s["shootingmode"] ?: s["shootingmodedial"] else s[key]) ?: continue
            val changeable = if (key == "shootingmode") modeChangeable() else item.changeable
            val entry = linkedMapOf<String, JsonElement>("value" to item.value)
            if (key == "shootingmode") {
                val list = (item.ability as? Ability.Options)?.values ?: emptyList()
                entry["options"] = JsonArray(if (changeable) list.map { JsonPrimitive(it) } else emptyList())
                if (!changeable || list.isEmpty()) entry["note"] = JsonPrimitive("set by the mode dial; can't be changed")
            } else if (changeable) {
                entry["options"] = item.ability.toJson()
            } else if (key == "hfflickertv") {
                entry["note"] = JsonPrimitive("set by detect_flicker with kind high_frequency")
            } else if (key in EXPOSURE_KEYS) {
                entry["value"] = effective[key]?.let { JsonPrimitive(it) } ?: JsonNull
                entry["note"] = JsonPrimitive("chosen by the camera in this mode")
            } else {
                entry["note"] = JsonPrimitive("not available with the current settings (another setting rules it out)")
            }
            out[key] = JsonObject(entry)
        }
        var styleDetail: JsonObject? = null
        val style = s["picturestyle"]?.text.orEmpty()
        if (style.isNotEmpty()) {
            try {
                val d = client.pictureStyleDetail(style)
                val value = d.value as? JsonObject
                val ability = (d.ability as? Ability.Composite)?.fields
                if (value != null) styleDetail = JsonObject(STYLE_DETAIL_FIELDS.filter { it in value }.associateWith { f ->
                    buildJsonObject {
                        put("value", value[f]!!)
                        ability?.get(f)?.let { put("range", it.toJson()) }
                    }
                })
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // not every style or camera exposes fine-tuning
            }
        }
        val battery = client.battery()
        return buildJsonObject {
            put("camera", describe())
            put("battery", battery)
            put("exposure_now", exposureLine(s))
            put("settings", JsonObject(out))
            styleDetail?.let { put("style_detail", it) }
        }.toString()
    }

    /** Whether the shooting mode can be set remotely (not only by the mode dial). */
    fun modeChangeable() =
        client.has("shooting/settings/shootingmode", "put") || client.has("shooting/settings/shootingmodedial", "put")

    /**
     * The current value of every setting the agent may change (or only [keys]),
     * for a preset. Settings the camera picks itself or can't change now are left out.
     */
    suspend fun snapshot(keys: List<String>? = null): JsonObject {
        val s = refresh()
        val out = linkedMapOf<String, JsonElement>()
        for (key in AGENT_SETTINGS) {
            if (keys != null && key !in keys) continue
            val item = (if (key == "shootingmode") s["shootingmode"] ?: s["shootingmodedial"] else s[key]) ?: continue
            val v = item.value
            if (v is JsonNull || (v is JsonPrimitive && v.isString && v.content.isEmpty())) continue
            if (if (key == "shootingmode") !modeChangeable() else !item.changeable) continue
            out[key] = v
        }
        val style = s["picturestyle"]?.text.orEmpty()
        if (style.isNotEmpty() && (keys == null || "style_detail" in keys)) {
            try {
                val value = client.pictureStyleDetail(style).value as? JsonObject
                val detail = STYLE_DETAIL_FIELDS.mapNotNull { f ->
                    val n = value?.get(f) as? JsonPrimitive
                    if (n != null && !n.isString && n.doubleOrNull != null) f to n else null
                }.toMap()
                if (detail.isNotEmpty()) out["style_detail"] = JsonObject(detail)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // no fine-tuning on this style or camera
            }
        }
        return JsonObject(out)
    }

    /** An idea picture from the image model (a PNG or JPEG data URL) as a small JPEG data URL that fits a HUD update. */
    suspend fun ideaPicture(dataUrl: String, side: Int): String {
        val bytes = Base64.getMimeDecoder().decode(dataUrl.substringAfter(','))
        val img = images.prepare(bytes, side, 0.7)
        if (img.dataUrl.length <= IDEA_IMAGE_BYTES) return img.dataUrl
        return images.prepare(bytes, (side * 0.7).roundToInt(), 0.55).dataUrl
    }

    /** A live-view frame; [zoom] (5 or 10) magnifies around the AF point to check focus, then zooms back out. */
    suspend fun look(zoom: Int? = null): Pair<String, PreparedImage> {
        var zoomed = false
        if (zoom == 5 || zoom == 10) {
            try {
                client.set("lvzoom", zoom.toString())
                zoomed = true
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // no magnified live view on this camera: plain frame
            }
        }
        val jpeg = try {
            client.liveFrame()
        } finally {
            // Also when cancelled: live view mustn't stay magnified. Best effort, and bounded.
            if (zoomed) withContext(NonCancellable) {
                runCatching { withTimeoutOrNull(5_000) { client.set("lvzoom", "1") } }
            }
        }
        val image = images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.8)
        drainEvents()
        val what = when {
            zoomed -> "Live view magnified ${zoom}x around the AF point"
            zoom != null -> "Live view (this camera can't magnify)"
            else -> "Live view"
        }
        return "$what at ${exposureLine()}. ${statsLine(image.stats)}" to image
    }

    /**
     * Runs the camera's flicker detection. Mains: reports 100/120 Hz flicker.
     * High frequency (LED panels): switches on HF anti-flicker if needed, runs
     * the detection with live view on, and lets the camera take the shutter
     * speed that spans whole flicker periods.
     */
    suspend fun detectFlicker(kind: String): Pair<List<String>, String> {
        val applied = mutableListOf<String>()
        fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.contentOrNull
        if (kind != "high_frequency") {
            val r = client.detectFlicker()
            val freq = str(r, "frequency")
            return applied to if (str(r, "result") == "ok") {
                "Flicker detected${freq?.let { " at $it" } ?: ""}. Anti-flicker shooting (antiflickershoot \"enable\", not with the electronic shutter) or a shutter speed of whole flicker periods removes it."
            } else "No mains flicker detected."
        }
        val hf = settings["hfantiflickershoot"]
        if (hf != null && hf.text != "enable") {
            client.set("hfantiflickershoot", "enable", hf)
            applied.add(CameraValues.diffLine("hfantiflickershoot", hf.text, "enable"))
        }
        client.liveFrame() // detection needs live view running
        val r = client.hfFlickerDetection("start", true)
        refresh()
        val tv = str(r, "tv")
        val freq = str(r, "frequency")
        tv?.let { applied.add(CameraValues.diffLine("hfflickertv", "\u2013", it)) }
        val found = str(r, "result") == "ok" || freq != null
        return applied to if (found) {
            "High-frequency flicker at ${freq ?: "an unknown frequency"}; the camera set the HF anti-flicker shutter speed to ${tv ?: "its recommendation"}, which spans whole flicker periods. Shoot in Tv or M to use it."
        } else "No high-frequency flicker found (${str(r, "result") ?: "no result"})."
    }

    /**
     * Puts the AF point at ([x], [y]), as fractions of the frame from the top left.
     * Tracking AF ignores the point, so it switches to 1-point AF first.
     */
    suspend fun focusAt(x: Double, y: Double): Pair<List<String>, String> {
        val fx = x.coerceIn(0.0, 1.0)
        val fy = y.coerceIn(0.0, 1.0)
        val (w, h) = client.liveDetail("info").info?.sensorSize
            ?: throw IllegalStateException("the camera doesn't report its image size, so the AF point can't be placed.")
        val applied = mutableListOf<String>()
        val method = settings["afmethod"]?.text.orEmpty()
        if (method == "face+tracking" || method == "whole_area") {
            val options = (settings["afmethod"]?.ability as? Ability.Options)?.values ?: emptyList()
            val to = listOf("1point", "spot", "expand_cross").firstOrNull { it in options }
                ?: throw IllegalStateException("AF area $method ignores the AF point and can't be changed now.")
            client.set("afmethod", to, settings["afmethod"])
            applied.add(CameraValues.diffLine("afmethod", method, to))
        }
        client.setAfFramePosition((fx * w).roundToInt(), (fy * h).roundToInt())
        val where = "${(fx * 100).roundToInt()}% across, ${(fy * 100).roundToInt()}% down"
        applied.add("AF point → $where")
        refresh()
        val note = if (applied.size > 1) " (${applied[0]})" else ""
        return applied to "AF point moved to $where$note. The next shot with af true focuses there."
    }

    class SetResult(val applied: List<String>, val errors: List<String>)

    /**
     * Applies changes in a safe order: the settings that change what else is
     * available come first, so the rest are judged against the new options.
     * Each change is validated against the camera's current options; failures
     * don't stop the rest.
     */
    suspend fun set(changes: Map<String, JsonElement>): SetResult {
        val order = LEADING_SETTINGS + AGENT_SETTINGS.filter { it !in LEADING_SETTINGS }
        val keys = order.filter { k -> changes[k].let { it != null && it !is JsonNull } }
        val applied = mutableListOf<String>()
        val errors = mutableListOf<String>()
        var s = refresh()
        for (key in keys) {
            val item: SettingItem? = if (key == "shootingmode") s["shootingmode"] ?: s["shootingmodedial"] else s[key]
            val value: Any
            if (key == "wbshift") {
                val v = changes[key] as? JsonObject ?: run {
                    errors.add("wbshift takes an object with ba and mg.")
                    null
                } ?: continue
                val cur = item?.fields ?: emptyMap()
                // Left out keeps the current shift; a value that isn't a number is NaN, which validation rejects.
                fun field(f: String): Number = when (val x = v[f]) {
                    null, is JsonNull -> (cur[f] as? Number)?.toInt() ?: 0
                    else -> (x as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }?.roundToInt() ?: Double.NaN
                }
                value = mapOf("ba" to field("ba"), "mg" to field("mg"))
            } else {
                val raw = changes[key] as? JsonPrimitive ?: run {
                    errors.add("$key = ${changes[key]} is not accepted.")
                    null
                } ?: continue
                value = if (key == "colortemperature") {
                    (raw.doubleOrNull ?: raw.contentOrNull?.toDoubleOrNull() ?: Double.NaN).let { if (it.isNaN()) raw.content else it.roundToInt() }
                } else raw.content.trim()
            }
            val before: Any? = item?.let { if (key == "wbshift") it.fields.mapValues { (_, n) -> (n as? Number)?.toInt() } else primitiveValue(it.value) }
            if (sameValue(before, value)) continue
            try {
                client.set(key, value, if (key == "shootingmode") null else item)
                applied.add(CameraValues.diffLine(key, if (before == "") effective[key] ?: "auto" else before, value))
                if (key in LEADING_SETTINGS) s = refresh()
            } catch (e: SettingException) {
                errors.add(e.message ?: "$key was rejected")
            } catch (e: CcapiException) {
                errors.add("$key: camera error ${e.status} ${e.message}")
            }
        }
        (changes["style_detail"] as? JsonObject)?.let { setStyleDetail(it, applied, errors) }
        refresh()
        return SetResult(applied, errors)
    }

    /** Fine-tunes the current picture style (contrast, saturation, sharpness, colour tone). */
    private suspend fun setStyleDetail(detail: JsonObject, applied: MutableList<String>, errors: MutableList<String>) {
        val style = settings["picturestyle"]?.text.orEmpty()
        val changes = STYLE_DETAIL_FIELDS.mapNotNull { f -> (detail[f] as? JsonPrimitive)?.doubleOrNull?.let { f to it.roundToInt() } }.toMap()
        if (style.isEmpty() || changes.isEmpty()) return
        try {
            val before = client.pictureStyleDetail(style).fields
            client.setPictureStyleDetail(style, changes)
            for ((f, v) in changes) if ((before[f] as? Number)?.toInt() != v) applied.add(CameraValues.diffLine(f, before[f] ?: "-", v))
        } catch (e: SettingException) {
            errors.add(e.message ?: "picture style $style was rejected")
        } catch (e: CcapiException) {
            errors.add("picture style $style: camera error ${e.status} ${e.message}")
        }
    }

    /** Takes a picture, waits for the file, downloads a display-size copy. */
    suspend fun shoot(af: Boolean, n: Int): ShotResult {
        drainEvents()
        val before = settings
        // The first camera-chosen values after the press are the ones the shot
        // used (with the new file, or just after it); later ones are the live
        // meter again.
        val used = mutableMapOf<String, String>()
        fun seen(ev: JsonObject) {
            absorb(ev)
            for ((k, v) in effectiveValues(ev)) used.putIfAbsent(k, v)
        }
        client.shutter(af)
        val path = client.waitForNewFile(20_000) { seen(it) }
        val jpeg = client.download(path, "display")
        val image = images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.82)
        val thumb = images.prepare(jpeg, THUMB_SIDE, 0.6).dataUrl
        try {
            seen(client.poll("immediately"))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // cameras without polling: the settings stand in
        }
        return ShotResult(n, jpeg, image, thumb, exposureLine(before, used), before)
    }
}

/** A JSON scalar as a Kotlin value: String, Int/Double, or null. */
private fun primitiveValue(e: JsonElement): Any? {
    val p = e as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    if (p.isString) return p.content
    return p.content.toIntOrNull() ?: p.doubleOrNull ?: p.content
}

private fun sameValue(a: Any?, b: Any): Boolean = when {
    a is Number && b is Number -> a.toDouble() == b.toDouble()
    else -> a == b
}
