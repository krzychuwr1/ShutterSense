package dev.shuttersense.app.ui.welcome

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.Smartphone
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.GlassesGlyph
import dev.shuttersense.app.ui.components.PrimaryButton
import dev.shuttersense.app.ui.components.TextAction
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

// First launch (and About → How it works): three pages, Ask → Look & shoot →
// Report, over a diagram of camera, phone, model and glasses whose links light
// up with the page and carry travelling dots.

private class Page(val eyebrow: String, val title: String, val body: String)

private val PAGES = listOf(
    Page(
        "Ask",
        "Say the shot.",
        "Tell it what you want in plain words, typed or spoken: “Get rid of the stripes from the stage lights.” Your phone passes it to the model.",
    ),
    Page(
        "Look & shoot",
        "It works the camera.",
        "The agent reads the camera, checks the live view, sets aperture, shutter, ISO and more, and takes test shots until it's right.",
    ),
    Page(
        "Report",
        "You see every step.",
        "Each change shows on your phone, and on Ray-Ban Display glasses if you pair them. Say “a bit warmer” and it carries on.",
    ),
)

@Composable
fun WelcomeScreen(onDone: () -> Unit, canGoBack: Boolean) {
    val pager = rememberPagerState { PAGES.size }
    val scope = rememberCoroutineScope()
    if (canGoBack) BackHandler(onBack = onDone)
    val last = pager.currentPage == PAGES.lastIndex

    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Ink).windowInsetsPadding(WindowInsets.safeDrawing)) {
        val wide = maxWidth >= 680.dp
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 24.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Shutter Sense", style = MaterialTheme.typography.titleMedium, color = Palette.Text, modifier = Modifier.weight(1f))
                AnimatedVisibility(!last, enter = fadeIn(), exit = fadeOut()) { TextAction("Skip", onDone) }
            }
            val diagram = @Composable { m: Modifier -> FlowDiagram(pager.currentPage, pager.currentPageOffsetFraction, m) }
            val text = @Composable { m: Modifier ->
                Column(m) {
                    HorizontalPager(pager, Modifier.fillMaxWidth().weight(1f, fill = false)) { i ->
                        val p = PAGES[i]
                        Column(Modifier.fillMaxWidth().padding(horizontal = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Eyebrow("${i + 1} / ${PAGES.size}  ·  ${p.eyebrow}", color = Palette.Accent)
                            Text(p.title, style = MaterialTheme.typography.displaySmall, color = Palette.Text)
                            Text(p.body, style = MaterialTheme.typography.bodyLarge, color = Palette.Muted)
                        }
                    }
                    Spacer(Modifier.height(28.dp))
                    Row(Modifier.padding(horizontal = 28.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PAGES.indices.forEach { i ->
                            val w by animateDpAsState(if (i == pager.currentPage) 22.dp else 6.dp, spring(stiffness = 500f), label = "ind")
                            Box(Modifier.height(6.dp).width(w).clip(CircleShape).background(if (i == pager.currentPage) Palette.Accent else Palette.Raised2))
                        }
                    }
                    Spacer(Modifier.height(28.dp))
                    PrimaryButton(
                        if (last) "Get started" else "Next",
                        { if (last) onDone() else scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } },
                        Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                    )
                    Text(
                        "Works with cameras that support CCAPI",
                        Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 8.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.Faint,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
            }
            if (wide) {
                Row(Modifier.fillMaxSize().padding(bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    diagram(Modifier.weight(1f).height(360.dp).padding(horizontal = 24.dp))
                    text(Modifier.weight(1f).widthIn(max = 520.dp))
                }
            } else {
                Column(Modifier.fillMaxSize().padding(bottom = 12.dp)) {
                    Spacer(Modifier.weight(0.4f))
                    diagram(Modifier.fillMaxWidth().height(320.dp).padding(horizontal = 16.dp))
                    Spacer(Modifier.weight(0.6f))
                    text(Modifier.fillMaxWidth())
                }
            }
        }
    }
}

// ------------------------------------------------------------------ diagram

private enum class Node(val label: String, val x: Float, val y: Float) {
    CAMERA("Camera", 0.13f, 0.56f),
    PHONE("Phone", 0.47f, 0.56f),
    MODEL("Model", 0.85f, 0.2f),
    GLASSES("Glasses", 0.85f, 0.88f),
}

/** A link and, per page, how strongly it shows and which way its dots run (+1 out from the phone, -1 in, 0 both). */
private class Link(val a: Node, val b: Node, val strength: List<Float>, val direction: List<Int>)

private val LINKS = listOf(
    Link(Node.PHONE, Node.CAMERA, listOf(0f, 1f, 0.15f), listOf(0, 0, 0)),
    Link(Node.PHONE, Node.MODEL, listOf(1f, 0.55f, 0.15f), listOf(1, 0, 1)),
    Link(Node.PHONE, Node.GLASSES, listOf(0.1f, 0.1f, 1f), listOf(1, 1, 1)),
)

/** Which nodes glow on each page. */
private val ACTIVE = listOf(
    setOf(Node.PHONE, Node.MODEL),
    setOf(Node.CAMERA, Node.PHONE),
    setOf(Node.PHONE, Node.GLASSES),
)

/** The little caption that appears beside the busy part of the diagram. */
private val BUBBLES = listOf(
    Node.PHONE to "“Lose the stripes”",
    Node.CAMERA to "HF anti-flicker  ·  1/1307 s",
    Node.GLASSES to "Done · no banding, still silent",
)

@Composable
private fun FlowDiagram(page: Int, offset: Float, modifier: Modifier) {
    val t = rememberInfiniteTransition(label = "flow")
    val phase by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "phase")
    val pulse by t.animateFloat(1f, 1.18f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "pulse")
    // Blend towards the page being swiped in.
    val pos = (page + offset).coerceIn(0f, (PAGES.size - 1).toFloat())

    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val wPx = with(density) { maxWidth.toPx() }
        val hPx = with(density) { maxHeight.toPx() }
        fun at(n: Node) = Offset(n.x * wPx, n.y * hPx)
        val nodeR = with(density) { 30.dp.toPx() }

        val strengths = LINKS.map { l ->
            val target = interpolate(l.strength, pos)
            animateFloatAsState(target, spring(stiffness = 300f), label = "link").value
        }

        Canvas(Modifier.fillMaxSize()) {
            LINKS.forEachIndexed { i, l ->
                val s = strengths[i]
                val a = at(l.a)
                val b = at(l.b)
                drawLine(lerp(Palette.Raised2, Palette.Accent.copy(alpha = 0.55f), s), a, b, (1.5f + s * 1.5f).dp.toPx(), StrokeCap.Round)
                if (s > 0.05f) dots(a, b, nodeR, phase, l.direction[page.coerceIn(0, PAGES.lastIndex)], s)
            }
        }

        Node.entries.forEach { n ->
            val active = n in ACTIVE[pos.roundToInt().coerceIn(0, PAGES.lastIndex)]
            val glow by animateFloatAsState(if (active) 1f else 0f, tween(400), label = "glow")
            val c = at(n)
            Column(
                Modifier.offset { IntOffset((c.x - nodeR * 1.6f).roundToInt(), (c.y - nodeR).roundToInt()) }.width(with(density) { (nodeR * 3.2f).toDp() }),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    // Soft ring that breathes around the active nodes.
                    Box(
                        Modifier.size(60.dp).scale(1f + (pulse - 1f) * glow).clip(CircleShape)
                            .background(Palette.Accent.copy(alpha = 0.12f * glow)),
                    )
                    Box(
                        Modifier.size(60.dp).clip(CircleShape)
                            .background(lerp(Palette.Raised, Color(0xFF2A2010), glow))
                            .border(1.dp, Palette.Accent.copy(alpha = 0.6f * glow), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        val tint = lerp(Palette.Muted, Palette.Accent, glow)
                        when (n) {
                            Node.CAMERA -> NodeIcon(Icons.Rounded.PhotoCamera, tint)
                            Node.PHONE -> NodeIcon(Icons.Rounded.Smartphone, tint)
                            Node.MODEL -> NodeIcon(Icons.Rounded.AutoAwesome, tint)
                            Node.GLASSES -> GlassesGlyph(tint, size = 28.dp)
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(n.label, style = MaterialTheme.typography.labelMedium, color = lerp(Palette.Faint, Palette.Text, glow))
            }
        }

        AnimatedContent(
            pos.roundToInt().coerceIn(0, PAGES.lastIndex),
            transitionSpec = { (fadeIn(tween(300, 120)) + scaleIn(initialScale = 0.92f)) togetherWith fadeOut(tween(150)) },
            label = "bubble",
        ) { p ->
            val (node, text) = BUBBLES[p]
            val c = at(node)
            val gap = with(density) { 12.dp.toPx() }
            // Above its node, except the glasses: beside them, clear of the link.
            val place = if (node == Node.GLASSES) Modifier.anchored(c.x - nodeR - gap, c.y - gap, 1f, 0f, wPx)
            else Modifier.anchored(c.x, c.y - nodeR - gap, 0.5f, 1f, wPx)
            Text(
                text,
                place
                    .clip(RoundedCornerShape(14.dp))
                    .background(Palette.Raised2)
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                style = MaterialTheme.typography.labelMedium,
                color = Palette.Text,
            )
        }
    }
}

/**
 * Places the element so the point ([ax], [ay]) of it (fractions of its size)
 * sits at ([x], [y]), kept inside [maxW].
 */
private fun Modifier.anchored(x: Float, y: Float, ax: Float, ay: Float, maxW: Float) = layout { measurable, constraints ->
    val p = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
    val left = (x - p.width * ax).coerceIn(0f, (maxW - p.width).coerceAtLeast(0f))
    layout(constraints.maxWidth, constraints.maxHeight) { p.place(left.roundToInt(), (y - p.height * ay).roundToInt()) }
}

@Composable
private fun NodeIcon(icon: ImageVector, tint: Color) = Icon(icon, null, Modifier.size(26.dp), tint = tint)

/** A value per page, read at a fractional page position. */
private fun interpolate(values: List<Float>, pos: Float): Float {
    val i = pos.toInt().coerceIn(0, values.lastIndex)
    val j = (i + 1).coerceAtMost(values.lastIndex)
    val f = pos - i
    return values[i] + (values[j] - values[i]) * f
}

/** Three dots along a link, kept clear of the node circles, fading in and out at the ends. */
private fun DrawScope.dots(from: Offset, to: Offset, gap: Float, phase: Float, direction: Int, strength: Float) {
    val d = to - from
    val len = d.getDistance()
    if (len < gap * 2) return
    val unit = d / len
    val start = from + unit * gap
    val span = len - gap * 2
    val passes = if (direction == 0) listOf(1, -1) else listOf(direction)
    for (dir in passes) {
        for (k in 0 until 3) {
            var p = (phase + k / 3f) % 1f
            if (direction == 0 && dir < 0) p = (p + 1f / 6f) % 1f
            val along = if (dir > 0) p else 1f - p
            val center = start + unit * (span * along)
            val fade = (minOf(p, 1f - p) * 5f).coerceIn(0f, 1f)
            val color = Palette.Accent.copy(alpha = fade * strength)
            drawCircle(Brush.radialGradient(listOf(color.copy(alpha = color.alpha * 0.35f), Color.Transparent), center, 9.dp.toPx()), 9.dp.toPx(), center)
            drawCircle(color, 3.dp.toPx(), center)
        }
    }
}
