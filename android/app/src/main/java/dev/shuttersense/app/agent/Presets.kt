package dev.shuttersense.app.agent

import android.content.SharedPreferences
import dev.shuttersense.app.ccapi.CameraValues
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlin.math.roundToLong

// The photographer's presets: named camera settings to come back to ("club
// night"). The agent saves one with save_preset and applies one with
// apply_preset; they live on the phone only. A port of the presets part of
// shared/agent-api.ts (and presetLines from agent/loop.ts); keep them in step.

/** A setting the photographer sets by hand in the camera's menus (the API can't), kept in a preset. */
data class MenuSetting(val setting: String, val value: String)

data class Preset(
    val name: String,
    /** What it is for, in the agent's words ("Dimmed LED stages, silent shutter"). */
    val note: String,
    /** Agent setting -> value, as get_camera_state reports them (wbshift and style_detail are objects). In AGENT_SETTINGS order. */
    val settings: JsonObject,
    /** Settings the photographer sets by hand; apply_preset hands them back to the agent for menu_steps. */
    val menu: List<MenuSetting>,
    /** ISO date. */
    val saved: String,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("name", name)
        put("note", note)
        put("settings", settings)
        put("menu", buildJsonArray {
            menu.forEach { m ->
                add(buildJsonObject {
                    put("setting", m.setting)
                    put("value", m.value)
                })
            }
        })
        put("saved", saved)
    }
}

/** What the worker's instructions list for each preset. */
data class PresetSummary(
    val name: String,
    val note: String,
    /** "tv 1/1307, iso auto, …; by hand: HDR Mode Auto". */
    val settings: String,
)

/** Most presets the phone keeps, and the longest name, note and hand-set list (shared/agent-api.ts PRESET_LIMITS). */
const val PRESET_COUNT = 20
const val PRESET_NAME = 40
const val PRESET_NOTE = 120
const val PRESET_MENU = 4

private val SPACES = Regex("\\s+")

/** Preset names match ignoring case and spacing. */
fun presetKey(name: String): String = name.lowercase().replace(SPACES, " ").trim()

/** A string squeezed to single spaces, trimmed and cut to [max]; "" for anything that isn't a string. */
internal fun cleanText(v: JsonElement?, max: Int): String {
    val p = v as? JsonPrimitive ?: return ""
    if (!p.isString) return ""
    return p.content.replace(SPACES, " ").trim().take(max)
}

/** JavaScript's Number(v) for a JSON value: NaN when there is none or it isn't numeric. */
private fun jsNumber(v: JsonElement?): Double = when {
    v == null -> Double.NaN
    v is JsonNull -> 0.0
    v is JsonPrimitive && v.isString -> v.content.trim().let { if (it.isEmpty()) 0.0 else it.toDoubleOrNull() ?: Double.NaN }
    v is JsonPrimitive -> v.booleanOrNull?.let { if (it) 1.0 else 0.0 } ?: v.doubleOrNull ?: Double.NaN
    else -> Double.NaN
}

/** A whole number as JSON, the way JavaScript writes it (5600, not 5600.0). */
private fun jsonNumber(d: Double): JsonPrimitive = if (d == Math.floor(d) && Math.abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)

private fun jsRound(d: Double): Long = d.roundToLong()

/** A stored preset made safe (from storage, or an agent's save); null if it isn't one. */
fun cleanPreset(raw: JsonElement?): Preset? {
    val r = raw as? JsonObject ?: return null
    val name = cleanText(r["name"], PRESET_NAME)
    if (name.isEmpty()) return null
    val s = r["settings"] as? JsonObject ?: JsonObject(emptyMap())
    val settings = linkedMapOf<String, JsonElement>()
    for (k in AGENT_SETTINGS) {
        val v = s[k]
        val p = v as? JsonPrimitive
        when {
            p != null && p.isString && p.content.isNotEmpty() -> settings[k] = JsonPrimitive(p.content.take(40))
            p != null && p !is JsonNull && !p.isString && p.booleanOrNull == null && p.doubleOrNull?.isFinite() == true -> settings[k] = jsonNumber(p.doubleOrNull!!)
            k == "wbshift" && v is JsonObject -> settings[k] = buildJsonObject {
                put("ba", jsRound(jsNumber(v["ba"]).takeIf { !it.isNaN() } ?: 0.0))
                put("mg", jsRound(jsNumber(v["mg"]).takeIf { !it.isNaN() } ?: 0.0))
            }
        }
    }
    (s["style_detail"] as? JsonObject)?.let { d ->
        val detail = STYLE_DETAIL_FIELDS.filter { jsNumber(d[it]).isFinite() }.associateWith { JsonPrimitive(jsRound(jsNumber(d[it]))) }
        if (detail.isNotEmpty()) settings["style_detail"] = JsonObject(detail)
    }
    val menu = ((r["menu"] as? JsonArray) ?: emptyList<JsonElement>())
        .mapNotNull { m -> (m as? JsonObject)?.let { MenuSetting(cleanText(it["setting"], 60), cleanText(it["value"], 40)) } }
        .filter { it.setting.isNotEmpty() && it.value.isNotEmpty() }
        .take(PRESET_MENU)
    return Preset(name, cleanText(r["note"], PRESET_NOTE), JsonObject(settings), menu, cleanText(r["saved"], 40).ifEmpty { "1970-01-01T00:00:00.000Z" })
}

/** A setting's value as JavaScript's String(v) or JSON.stringify writes it. */
private fun plain(v: JsonElement): String = if (v is JsonPrimitive && v !is JsonNull) v.content else v.toString()

/** A preset's settings in one line, for the agent's instructions. */
fun presetLine(p: Preset): String {
    val line = p.settings.entries.joinToString(", ") { (k, v) -> "$k ${plain(v)}" }
    return if (p.menu.isNotEmpty()) "$line; by hand: ${p.menu.joinToString(", ") { "${it.setting} ${it.value}" }}" else line
}

fun presetSummary(p: Preset) = PresetSummary(p.name, p.note, presetLine(p).take(400))

/** A preset's settings, one per line, as the photographer reads them. */
fun presetLines(p: Preset): List<String> {
    val lines = p.settings.entries.map { (k, v) ->
        val label = CameraValues.SETTING_LABELS[k] ?: if (k == "style_detail") "Style detail" else k
        if (v is JsonObject) "$label: ${v.entries.joinToString(", ") { (f, n) -> "${CameraValues.SETTING_LABELS[f] ?: f} ${plain(n)}" }}"
        else "$label: ${if (k == "iso") plain(v) else CameraValues.prettyValue(k, plain(v))}"
    }
    return lines + p.menu.map { "${it.setting} (by hand): ${it.value}" }
}

/** Where the phone keeps the photographer's presets. */
interface PresetStore {
    fun list(): List<Preset>

    /** Adds the preset, replacing one with the same name (see [presetKey]). */
    fun save(preset: Preset)
}

/** Presets in the app's shared preferences, as a JSON array (oldest first, at most [PRESET_COUNT]). */
class PrefsPresetStore(private val prefs: SharedPreferences, private val key: String = "presets") : PresetStore {
    /** Called after every change, so a list on screen can refresh. */
    var onChange: (() -> Unit)? = null

    override fun list(): List<Preset> {
        val raw = prefs.getString(key, null) ?: return emptyList()
        val array = try {
            Json.parseToJsonElement(raw) as? JsonArray
        } catch (_: Exception) {
            null
        } ?: return emptyList()
        return array.mapNotNull(::cleanPreset)
    }

    override fun save(preset: Preset) {
        val rest = list().filter { presetKey(it.name) != presetKey(preset.name) }
        write((rest + preset).takeLast(PRESET_COUNT))
    }

    fun remove(name: String) {
        write(list().filter { presetKey(it.name) != presetKey(name) })
    }

    private fun write(presets: List<Preset>) {
        prefs.edit().putString(key, JsonArray(presets.map { it.toJson() }).toString()).apply()
        onChange?.invoke()
    }
}
