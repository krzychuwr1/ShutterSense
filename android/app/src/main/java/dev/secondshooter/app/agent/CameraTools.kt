package dev.secondshooter.app.agent

import dev.secondshooter.app.ccapi.Ability
import dev.secondshooter.app.ccapi.CameraValues
import dev.secondshooter.app.ccapi.CcapiClient
import dev.secondshooter.app.ccapi.CcapiException
import dev.secondshooter.app.ccapi.SettingException
import dev.secondshooter.app.ccapi.SettingItem
import dev.secondshooter.app.ccapi.Settings
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

// The agent's camera tools on the CCAPI client: what get_camera_state, look,
// set_settings and shoot do, and what the model gets back. A port of
// agent/camera-tools.ts; keep the two in step.

/** Settings the agent may change. Never storage, formats, network or power. */
val AGENT_SETTINGS = listOf(
    "shootingmode", "av", "tv", "iso", "exposure", "wb", "colortemperature",
    "metering", "afoperation", "afmethod", "drive", "picturestyle",
)

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
        } catch (_: Exception) {
            // optional
        }
        lensName = client.lens()
        drainEvents()
        settings = client.settings()
        return describe()
    }

    fun describe() = lensName?.let { "$model, lens $it" } ?: model

    private fun absorb(ev: JsonObject) {
        for (k in listOf("av", "tv", "iso", "exposure")) {
            val v = ((ev["effective_value_$k"] as? JsonObject)?.get("value") as? JsonPrimitive)
            if (v != null && v.isString && v.content.isNotEmpty()) effective[k] = v.content
        }
    }

    /** Reads pending events so later waits only see new ones. */
    suspend fun drainEvents() {
        try {
            absorb(client.poll("immediately"))
        } catch (_: Exception) {
            // cameras without polling still work, minus effective values
        }
    }

    suspend fun refresh(): Settings {
        drainEvents()
        settings = client.settings()
        return settings
    }

    /** "Av · f/2.8 · 1/1000 s · ISO 1600 (auto) · +1 EV", using camera-chosen values where the mode picks them. */
    fun exposureLine(s: Settings = settings): String {
        fun v(k: String): String {
            val own = s[k]?.text
            return if (!own.isNullOrEmpty()) own else effective[k] ?: ""
        }
        val mode = s["shootingmode"]?.text?.takeIf { it.isNotEmpty() } ?: s["shootingmodedial"]?.text ?: ""
        val parts = mutableListOf(
            CameraValues.prettyValue("shootingmode", mode),
            CameraValues.prettyValue("av", v("av")),
            CameraValues.prettyValue("tv", v("tv")),
        )
        val iso = if (s["iso"]?.text == "auto" && effective["iso"] != null) "ISO ${effective["iso"]} (auto)" else CameraValues.prettyValue("iso", v("iso"))
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
            } else {
                entry["value"] = effective[key]?.let { JsonPrimitive(it) } ?: JsonNull
                entry["note"] = JsonPrimitive("chosen by the camera in this mode")
            }
            out[key] = JsonObject(entry)
        }
        val battery = client.battery()
        return buildJsonObject {
            put("camera", describe())
            put("battery", battery)
            put("exposure_now", exposureLine(s))
            put("settings", JsonObject(out))
        }.toString()
    }

    private fun modeChangeable() =
        client.has("shooting/settings/shootingmode", "put") || client.has("shooting/settings/shootingmodedial", "put")

    suspend fun look(): Pair<String, PreparedImage> {
        val jpeg = client.liveFrame()
        val image = images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.8)
        drainEvents()
        return "Live view at ${exposureLine()}. ${statsLine(image.stats)}" to image
    }

    class SetResult(val applied: List<String>, val errors: List<String>)

    /**
     * Applies changes in a safe order (mode first, so the other settings are
     * judged in the new mode). Each change is validated against the camera's
     * current options; failures don't stop the rest.
     */
    suspend fun set(changes: Map<String, JsonElement>): SetResult {
        val order = listOf("shootingmode", "iso") + AGENT_SETTINGS.filter { it != "shootingmode" && it != "iso" }
        val keys = order.filter { k -> changes[k].let { it != null && it !is JsonNull } }
        val applied = mutableListOf<String>()
        val errors = mutableListOf<String>()
        var s = refresh()
        for (key in keys) {
            val raw = changes[key] as? JsonPrimitive ?: run {
                errors.add("$key = ${changes[key]} is not accepted.")
                null
            } ?: continue
            val value: Any = if (key == "colortemperature") {
                (raw.doubleOrNull ?: raw.contentOrNull?.toDoubleOrNull() ?: Double.NaN).let { if (it.isNaN()) raw.content else it.roundToInt() }
            } else raw.content.trim()
            val item: SettingItem? = if (key == "shootingmode") s["shootingmode"] ?: s["shootingmodedial"] else s[key]
            val before: Any? = item?.let { primitiveValue(it.value) }
            if (sameValue(before, value)) continue
            try {
                client.set(key, value, if (key == "shootingmode") null else item)
                applied.add(CameraValues.diffLine(key, if (before == "") effective[key] ?: "auto" else before, value))
                // Mode and ISO change which other settings are available.
                if (key == "shootingmode" || key == "iso") s = refresh()
            } catch (e: SettingException) {
                errors.add(e.message ?: "$key was rejected")
            } catch (e: CcapiException) {
                errors.add("$key: camera error ${e.status} ${e.message}")
            }
        }
        refresh()
        return SetResult(applied, errors)
    }

    /** Takes a picture, waits for the file, downloads a display-size copy. */
    suspend fun shoot(af: Boolean, n: Int): ShotResult {
        drainEvents()
        val before = settings
        client.shutter(af)
        val path = client.waitForNewFile(20_000) { absorb(it) }
        val jpeg = client.download(path, "display")
        val image = images.prepare(jpeg, MODEL_IMAGE_SIDE, 0.82)
        val thumb = images.prepare(jpeg, THUMB_SIDE, 0.6).dataUrl
        drainEvents()
        return ShotResult(n, jpeg, image, thumb, exposureLine(before), before)
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
