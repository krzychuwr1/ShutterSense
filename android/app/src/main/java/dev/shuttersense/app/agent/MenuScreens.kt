package dev.shuttersense.app.agent

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

// Camera menu screens for settings the control API can't change. The worker
// builds them from the camera's menu map (shared/menus/): the tab page with
// all its rows, then each sub-screen down to the value; the phone and the
// glasses draw them like the camera's own menus. A port of the screen
// contract in shared/menu.ts; keep the two in step.

val MENU_TABS = listOf("shoot", "af", "play", "wireless", "setup", "custom", "mymenu")

/** How each tab is named in hints. */
val MENU_TAB_NAMES = mapOf(
    "shoot" to "SHOOT",
    "af" to "AF",
    "play" to "PLAY",
    "wireless" to "NETWORK",
    "setup" to "SET UP",
    "custom" to "CUSTOM",
    "mymenu" to "MY MENU",
)

data class MenuScreen(
    val tab: String,
    /** A tab page: its number, 1-based. Null on a sub-screen. */
    val page: Int?,
    /** Rows on this page or option list, in menu order (at most 8). */
    val items: List<String>,
    /** The row to pick; one of [items]. */
    val select: String,
    /** How many pages the tab has, for the page row. */
    val pages: Int? = null,
    /** A sub-screen's title (the setting), or a page's own heading (e.g. "Servo AF"). */
    val title: String? = null,
    /** What each row shows on the right ("" for nothing), aligned with [items]; empty when none. */
    val values: List<String> = emptyList(),
    /** Rows the camera shows greyed out. */
    val dim: List<String> = emptyList(),
    /** The option currently set (the camera shows it in blue). */
    val current: String? = null,
    /** The options drop down beside the row instead of filling the screen. */
    val popup: Boolean = false,
    /** The camera model the screens come from (on the first screen). */
    val model: String? = null,
) {
    /** A sub-screen (setting title and options) rather than a tab page. */
    val isSub: Boolean get() = page == null && title != null

    fun value(i: Int): String = values.getOrNull(i) ?: ""

    fun toJson(): JsonObject = buildJsonObject {
        put("tab", tab)
        page?.let { put("page", it) }
        pages?.let { put("pages", it) }
        title?.let { put("title", it) }
        put("items", buildJsonArray { items.forEach { add(JsonPrimitive(it)) } })
        if (values.isNotEmpty()) put("values", buildJsonArray { values.forEach { add(JsonPrimitive(it)) } })
        if (dim.isNotEmpty()) put("dim", buildJsonArray { dim.forEach { add(JsonPrimitive(it)) } })
        current?.let { put("current", it) }
        put("select", select)
        if (popup) put("popup", true)
        model?.let { put("model", it) }
    }
}

/** Most screens a guide may have, rows per screen, and characters per row and value. */
private const val MAX_SCREENS = 6
private const val MAX_ITEMS = 8
private const val MAX_TEXT = 40
private const val MAX_VALUE = 24

/** A screen list (from the worker, or relayed to the glasses) made safe to draw: known tabs, bounded text, the selection among the rows. */
fun cleanMenu(raw: JsonElement?): List<MenuScreen> {
    val list = raw as? JsonArray ?: return emptyList()
    fun text(v: JsonElement?) = cleanText(v, MAX_TEXT)
    fun count(v: JsonElement?): Int? = (v as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
        ?.takeIf { it % 1.0 == 0.0 && it > 0 && it < 20 }?.toInt()
    val out = mutableListOf<MenuScreen>()
    for (s in list.take(MAX_SCREENS)) {
        val o = s as? JsonObject ?: continue
        val tab = (o["tab"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it in MENU_TABS }
        val rawValues = o["values"] as? JsonArray
        val items = mutableListOf<String>()
        val values = mutableListOf<String>()
        (o["items"] as? JsonArray)?.take(MAX_ITEMS)?.forEachIndexed { i, it ->
            val t = text(it)
            if (t.isEmpty()) return@forEachIndexed
            items.add(t)
            values.add(cleanText(rawValues?.getOrNull(i), MAX_VALUE))
        }
        val select = text(o["select"])
        if (tab == null || select.isEmpty()) continue
        if (select !in items) {
            if (items.size >= MAX_ITEMS) {
                items.removeAt(items.lastIndex)
                values.removeAt(values.lastIndex)
            }
            items.add(select)
            values.add("")
        }
        val page = count(o["page"])
        val pages = count(o["pages"])?.takeIf { page != null && it >= page }
        val dim = (o["dim"] as? JsonArray)?.map(::text)?.filter { it.isNotEmpty() && it != select && it in items } ?: emptyList()
        out.add(
            MenuScreen(
                tab, page, items, select,
                pages = pages,
                title = text(o["title"]).ifEmpty { null },
                values = if (values.any { it.isNotEmpty() }) values else emptyList(),
                dim = dim,
                current = text(o["current"]).takeIf { it in items },
                popup = (o["popup"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true,
                model = text(o["model"]).ifEmpty { null },
            ),
        )
    }
    return out
}

/** "Press MENU, open the AF tab, page 1, select Subject to detect" for the first screen, "Select Animals" after. */
fun screenHint(s: MenuScreen, i: Int): String {
    val tab = MENU_TAB_NAMES[s.tab] ?: s.tab
    return if (i == 0) "Press MENU, open the $tab tab${s.page?.let { ", page $it" } ?: ""}, select ${s.select}" else "Select ${s.select}"
}
