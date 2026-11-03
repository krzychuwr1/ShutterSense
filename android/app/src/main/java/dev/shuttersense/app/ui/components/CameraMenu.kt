package dev.shuttersense.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.agent.MENU_TABS
import dev.shuttersense.app.agent.MenuScreen
import dev.shuttersense.app.agent.screenHint
import dev.shuttersense.app.ui.Palette
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Camera menu screens (see agent/MenuScreens.kt) drawn the way the camera
// shows them: the row of tab icons with the current tab filled in its colour
// and a line of it underneath, the tab's page numbers, grey row strips with
// values on the right, and the cursor (an outline in the tab colour with bars
// at both edges) on the row to pick. Sub-screens show the setting's title and
// its options, the current one in blue. Sizes follow the screen's width.
// Mirrors web/src/camera-menu.ts and camera-menu.css. The icons are our own
// simple drawings.

/** Each tab's colour, and the darker one behind its current page number. */
private val TAB_COLORS = mapOf(
    "shoot" to (Color(0xFFA00412) to Color(0xFF520008)),
    "af" to (Color(0xFFA8007C) to Color(0xFF580042)),
    "play" to (Color(0xFF0A55AD) to Color(0xFF002A58)),
    "wireless" to (Color(0xFF6A1CA8) to Color(0xFF380A60)),
    "setup" to (Color(0xFFA08400) to Color(0xFF584600)),
    "custom" to (Color(0xFFA84600) to Color(0xFF582600)),
    "mymenu" to (Color(0xFF006C24) to Color(0xFF003A12)),
)

private val PANEL = Color.Black
private val ROW = Color(0xFF1E1E1E)
private val TEXT = Color(0xFFF2F2F2)
private val DIM = Color(0xFF6E6E6E)
private val CURRENT = Color(0xFF2BB7EA)
private val TAB_OFF = Color(0xFFD8D8D8)

/** Short codes (ON, OFF, AUTO, D+, 1/3): the camera draws them at the row's right edge; words go in the value column. */
private val CODE = Regex("""^[A-Z0-9+\-±./★]{1,5}$""")

/** A circle as SVG path data. */
private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

/** A tab icon on a 24-unit grid: [stroke] paths outlined, [filled] paths filled (even-odd, so a circle inside cuts a hole). */
private fun icon(name: String, stroke: String = "", filled: String = "", strokeWidth: Float = 1.7f): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        if (filled.isNotEmpty()) addPath(addPathNodes(filled), pathFillType = PathFillType.EvenOdd, fill = SolidColor(Color.White))
        if (stroke.isNotEmpty()) addPath(
            addPathNodes(stroke), stroke = SolidColor(Color.White), strokeLineWidth = strokeWidth,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        )
    }.build()

private val ICONS: Map<String, ImageVector> by lazy {
    mapOf(
        "shoot" to icon("shoot", filled = "M3.5 8.5h3.6l1.8-2.6h6.2l1.8 2.6h3.6v10h-17z" + circle(12f, 13.2f, 3.1f) + circle(12f, 13.2f, 1.9f)),
        "play" to icon("play", stroke = "M4 5.5h16v13H4z", filled = "M10 9v6l5-3z"),
        "wireless" to icon("wireless", stroke = "M3 15.5 7.5 10l4 5 4.5-6.5L20.5 14M3 12.6v3.4h3.3M20.5 10.8v3.6h-3.4"),
        "setup" to icon("setup", filled = "M8.8 4.5v4.2a3.2 3.2 0 0 0 2.2 3V19.5h2V11.7a3.2 3.2 0 0 0 2.2-3V4.5l-1.5 1.4v2.6h-3.4V5.9z"),
        "custom" to icon(
            "custom",
            stroke = "M5 19h.01M8 19h.01M11 19h.01M14 19h.01M17 19h.01",
            filled = "M4.5 7.5h3.2l1.6-2.2h5.4l1.6 2.2h3.2v8.5h-15z" + circle(12f, 11.6f, 2.6f),
            strokeWidth = 2f,
        ),
        "mymenu" to icon("mymenu", filled = "m12 4.2 2.3 4.8 5.3.6-3.9 3.6 1.1 5.2L12 15.8l-4.8 2.6 1.1-5.2-3.9-3.6 5.3-.6z"),
    )
}

/** Sizes as a share of the screen's width, like the web version's cqw units. */
private class Units(val u: Dp, private val density: androidx.compose.ui.unit.Density) {
    operator fun invoke(x: Float): Dp = u * x
    fun sp(x: Float): TextUnit = with(density) { (u * x).toSp() }
}

/** One menu screen, 4:3, black. */
@Composable
fun CameraMenuScreen(s: MenuScreen, modifier: Modifier = Modifier) {
    val (tab, tabDim) = TAB_COLORS[s.tab] ?: (Palette.Good to Palette.Good)
    BoxWithConstraints(
        modifier
            .aspectRatio(4f / 3f)
            .clip(RoundedCornerShape(10.dp))
            .background(PANEL)
            .border(1.dp, Color(0xFF1D1D1D), RoundedCornerShape(10.dp)),
    ) {
        val u = Units(maxWidth / 100f, LocalDensity.current)
        if (s.isSub) SubScreen(s, tab, u) else PageScreen(s, tab, tabDim, u)
    }
}

/** A tab page: tab icons, the page numbers, all rows of the page. */
@Composable
private fun PageScreen(s: MenuScreen, tab: Color, tabDim: Color, u: Units) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().height(u(9f))) {
            MENU_TABS.forEach { t ->
                val on = t == s.tab
                Box(
                    Modifier.weight(1f).fillMaxHeight().background(if (on) TAB_COLORS[t]?.first ?: tab else Color.Transparent),
                    contentAlignment = Alignment.Center,
                ) {
                    val c = if (on) Color.White else TAB_OFF
                    val ic = ICONS[t]
                    if (ic != null) Icon(ic, null, Modifier.size(u(6.4f)), tint = c)
                    else Text("AF", fontSize = u.sp(4.4f), fontWeight = FontWeight.Bold, color = c)
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(u(0.6f)).background(tab))
        val count = maxOf(s.pages ?: s.page ?: 1, s.page ?: 1)
        Row(Modifier.fillMaxWidth().height(u(7.5f)).padding(start = u(1f))) {
            for (p in 1..count) {
                val on = p == s.page
                Box(Modifier.width(u(9.6f)).fillMaxHeight().background(if (on) tabDim else Color.Transparent), contentAlignment = Alignment.Center) {
                    Text("$p", fontSize = u.sp(4.2f), fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, color = if (on) Color.White else Color(0xFFCFCFCF))
                }
            }
        }
        s.title?.let { Text(it, Modifier.padding(start = u(3f), top = u(0.8f)), fontSize = u.sp(4.4f), color = TEXT, maxLines = 1) }
        Spacer(Modifier.height(u(1.4f)))
        // The camera always shows seven strips; empty ones stay grey.
        val slots = maxOf(7, s.items.size)
        Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(u(0.45f))) {
            for (i in 0 until slots) {
                val item = s.items.getOrNull(i)
                val rowModifier = Modifier.fillMaxWidth().weight(1f)
                if (item == null) Box(rowModifier.background(ROW)) else MenuRow(s, item, s.value(i), tab, u, rowModifier, inset = 5f)
            }
        }
    }
}

/** A sub-screen: the setting's title, its rows or options, and the button hint. */
@Composable
private fun SubScreen(s: MenuScreen, tab: Color, u: Units) {
    Column(Modifier.fillMaxSize()) {
        Text(
            s.title ?: "", Modifier.padding(start = u(4f), end = u(4f), top = u(3f), bottom = u(1.4f)),
            fontSize = u.sp(4.9f), color = TEXT, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.padding(horizontal = u(3f)).fillMaxWidth().height(u(0.45f)).background(tab))
        Spacer(Modifier.height(u(2f)))
        if (s.popup) {
            // The options drop down beside the row, the cursor's option level with it.
            val at = s.items.indexOf(s.select).coerceAtLeast(0)
            Box(Modifier.fillMaxWidth().weight(1f)) {
                Box(
                    Modifier.offset(y = u(8.2f) * at).fillMaxWidth().height(u(7.8f)).background(tab).padding(start = u(4f)),
                    contentAlignment = Alignment.CenterStart,
                ) { Text(s.title ?: "", fontSize = u.sp(4.6f), color = TEXT, maxLines = 1) }
                Column(
                    Modifier.padding(start = u(50f), end = u(3f)).fillMaxWidth().border(u(0.5f), tab).background(PANEL),
                    verticalArrangement = Arrangement.spacedBy(u(0.4f)),
                ) {
                    s.items.forEachIndexed { i, item -> MenuRow(s, item, s.value(i), tab, u, Modifier.fillMaxWidth().height(u(7.8f)), inset = 4f, bar = 0.55f, background = PANEL) }
                }
            }
        } else {
            // Rows keep the camera's height; long lists squeeze to fit above the button hint.
            val slots = maxOf(6, s.items.size)
            val rowHeight = minOf(u(7.8f), u(50f) / slots - u(0.4f))
            Column(verticalArrangement = Arrangement.spacedBy(u(0.4f))) {
                s.items.forEachIndexed { i, item -> MenuRow(s, item, s.value(i), tab, u, Modifier.fillMaxWidth().height(rowHeight), inset = 4f) }
            }
            Spacer(Modifier.weight(1f))
        }
        Row(Modifier.fillMaxWidth().padding(end = u(3f), bottom = u(2.4f)), horizontalArrangement = Arrangement.End) {
            Row(
                Modifier.border(u(0.3f), Color(0xFF5A5A5A), RoundedCornerShape(u(1f))).padding(start = u(0.6f), end = u(1.4f), top = u(0.5f), bottom = u(0.5f)),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (s.current != null) "SET" else "MENU",
                    Modifier.clip(RoundedCornerShape(u(0.6f))).background(Color.White).padding(horizontal = u(1.4f), vertical = u(0.2f)),
                    fontSize = u.sp(3.6f), fontWeight = FontWeight.Bold, color = Color.Black,
                )
                Spacer(Modifier.width(u(1f)))
                Text(if (s.current != null) "OK" else "↩", fontSize = u.sp(4.2f), color = TEXT)
            }
        }
    }
}

/** One row: label, value on the right (codes at the edge, words in the value column), the cursor when selected. */
@Composable
private fun MenuRow(
    s: MenuScreen, item: String, value: String, tab: Color, u: Units, modifier: Modifier,
    inset: Float, bar: Float = 3.4f, background: Color = ROW,
) {
    val on = item == s.select
    val color = when {
        item == s.current -> CURRENT
        item in s.dim -> DIM
        else -> TEXT
    }
    Row(modifier.background(if (on) tab else background), verticalAlignment = Alignment.CenterVertically) {
        if (on) Spacer(Modifier.width(u(bar)))
        Row(
            Modifier.weight(1f).fillMaxHeight()
                .then(if (on) Modifier.background(PANEL).border(u(0.55f), tab) else Modifier)
                .padding(start = if (on) u(maxOf(inset - bar, 0.6f)) else u(inset), end = u(if (on) 0.8f else 3f)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                item, Modifier.widthIn(min = u(50f)).padding(end = u(2f)), fontSize = u.sp(4.6f), color = color,
                maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
            )
            if (value.isNotEmpty()) Text(
                value, Modifier.weight(1f), fontSize = u.sp(4.6f), color = color, maxLines = 1, softWrap = false,
                overflow = TextOverflow.Ellipsis, textAlign = if (CODE.matches(value)) TextAlign.End else TextAlign.Start,
            )
        }
        if (on) Spacer(Modifier.width(u(bar)))
    }
}

/** The screens one after another: swipe or step through; it advances by itself until touched. */
@Composable
fun CameraMenuGuide(screens: List<MenuScreen>, modifier: Modifier = Modifier) {
    val pager = rememberPagerState { screens.size }
    val scope = rememberCoroutineScope()
    var auto by remember { mutableStateOf(true) }
    val dragged by pager.interactionSource.collectIsDraggedAsState()
    if (dragged) auto = false
    LaunchedEffect(auto, screens.size) {
        while (auto && screens.size > 1) {
            delay(2600)
            if (auto) pager.animateScrollToPage((pager.currentPage + 1) % screens.size)
        }
    }
    val i = pager.currentPage
    Column(modifier.widthIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalPager(pager, Modifier.fillMaxWidth(), pageSpacing = 12.dp) { p -> CameraMenuScreen(screens[p], Modifier.fillMaxWidth()) }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            RoundIcon(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "Previous step", {
                auto = false
                scope.launch { pager.animateScrollToPage((i - 1).coerceAtLeast(0)) }
            }, size = 36.dp, container = Palette.Raised2, enabled = i > 0)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.Center) {
                screens.indices.forEach { j ->
                    Box(Modifier.padding(horizontal = 3.dp).size(6.dp).clip(CircleShape).background(if (j == i) Palette.Text else Palette.Faint))
                }
            }
            RoundIcon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Next step", {
                auto = false
                scope.launch { pager.animateScrollToPage((i + 1).coerceAtMost(screens.lastIndex)) }
            }, size = 36.dp, container = Palette.Raised2, enabled = i < screens.lastIndex)
        }
        Row {
            Text("${i + 1}/${screens.size}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold, color = Palette.Accent)
            Spacer(Modifier.width(8.dp))
            Text(screenHint(screens[i], i), style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
        }
        Text(
            "Menus differ a little between camera models",
            style = MaterialTheme.typography.bodySmall, color = Palette.Faint,
        )
    }
}
