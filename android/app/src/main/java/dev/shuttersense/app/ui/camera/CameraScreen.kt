package dev.shuttersense.app.ui.camera

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.animateColorAsState
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
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import dev.shuttersense.app.ccapi.CameraValues
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.Numeric
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.Tab
import dev.shuttersense.app.ui.components.PhotoViewer
import dev.shuttersense.app.ui.components.StatusDot
import dev.shuttersense.app.ui.components.TextAction
import dev.shuttersense.app.ui.components.pressScale
import dev.shuttersense.app.ui.components.rememberDataUrlImage
import dev.shuttersense.app.ui.setup.SceneChip
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

// Manual control: live view on top (tap to focus), the exposure dials, a
// snapping value strip for the chosen dial, and the shutter. Paused, with a
// note, while the agent has the camera.

@Composable
fun CameraScreen(vm: AppViewModel, modifier: Modifier = Modifier, showAgentLink: Boolean = true) {
    val m = vm.manual ?: return
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state by lifecycle.currentStateAsState()
    val live = state.isAtLeast(Lifecycle.State.RESUMED) && !vm.busy
    // The loop lives as long as this screen is shown, the app is in front and no run is going.
    LaunchedEffect(m, live) { if (live) m.runLiveView() }

    var viewing by remember { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf("av") }
    val dials = m.dials
    val current = dials.firstOrNull { it.key == selected } ?: dials.firstOrNull()

    Column(modifier) {
        LiveView(vm, m, Modifier.fillMaxWidth().padding(horizontal = 12.dp))
        Spacer(Modifier.height(14.dp))

        Box(Modifier.fillMaxWidth()) {
            Column(Modifier.alpha(if (vm.busy) 0.35f else 1f)) {
                DialRow(dials, current?.key, enabled = !vm.busy) { selected = it }
                Spacer(Modifier.height(6.dp))
                Box(Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
                    if (current != null) {
                        if (current.changeable && current.options.isNotEmpty()) {
                            key(current.key) { ValueStrip(current, enabled = !vm.busy && m.applying == null) { m.select(current.key, it) } }
                        } else {
                            val mode = CameraValues.prettyValue("shootingmode", dials.firstOrNull { it.key == "shootingmode" }?.value.orEmpty())
                            Text(
                                if (current.key == "shootingmode") "The mode is set on the camera's dial" else "Chosen by the camera in $mode",
                                style = MaterialTheme.typography.bodyMedium,
                                color = Palette.Muted,
                            )
                        }
                    }
                }
            }
            if (vm.busy) {
                Row(
                    Modifier.align(Alignment.Center).clip(CircleShape).background(Palette.Raised2).padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Paused while the agent works", style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
                    if (showAgentLink) TextAction("Show", { vm.tab = Tab.AGENT }, color = Palette.Accent) else Spacer(Modifier.width(10.dp))
                }
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            m.histogram?.let { if (!vm.busy) Histogram(it, Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 32.dp)) }
        }
        ShutterRow(m, enabled = !vm.busy, onOpen = { viewing = true })
        Spacer(Modifier.height(16.dp))
    }

    val shot = m.lastShot
    if (viewing && shot != null) PhotoViewer(shot.image, "Shot ${shot.n} · ${shot.exposure}") { viewing = false }
}

// ------------------------------------------------------------------ live view

@Composable
private fun LiveView(vm: AppViewModel, m: ManualCamera, modifier: Modifier) {
    // While the agent works, show what it last saw or shot instead of a frozen frame.
    val agentUrl = if (vm.busy) vm.steps.lastOrNull { it.image != null }?.image else null
    val agentImage = rememberDataUrlImage(agentUrl)
    val frame = if (vm.busy) agentImage ?: m.frame else m.frame
    val aspect = frame?.let { it.width.toFloat() / it.height } ?: 1.5f

    Box(
        modifier
            .aspectRatio(aspect)
            .clip(RoundedCornerShape(22.dp))
            .background(Color.Black)
            .pointerInput(m, vm.busy) {
                if (!vm.busy) detectTapGestures { p -> m.focus((p.x / size.width).coerceIn(0f, 1f), (p.y / size.height).coerceIn(0f, 1f)) }
            },
    ) {
        AnimatedContent(frame == null, transitionSpec = { fadeIn(tween(300)) togetherWith fadeOut(tween(300)) }, label = "lvready") { empty ->
            if (empty) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(m.liveError ?: "Starting live view…", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
                }
            } else {
                frame?.let { Image(it, "Live view", Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            }
        }

        if (!vm.busy) m.afPoint?.let { Reticle(it, m.focusing) }

        // Corner badges: live state, and the error if the stream drops.
        Row(
            Modifier.align(Alignment.TopStart).padding(12.dp).clip(CircleShape).background(Color(0x80000000)).padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                vm.busy -> {
                    androidx.compose.material3.Icon(Icons.Rounded.AutoAwesome, null, Modifier.size(12.dp), tint = Palette.Accent)
                    Spacer(Modifier.width(6.dp))
                    Text("Agent at work", style = MaterialTheme.typography.labelMedium, color = Color.White)
                }
                m.liveError != null && frame != null -> {
                    StatusDot(Palette.Bad, size = 6.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(m.liveError ?: "", style = MaterialTheme.typography.labelMedium, color = Color.White)
                }
                else -> {
                    StatusDot(Palette.Bad, pulse = true, size = 6.dp)
                    Spacer(Modifier.width(6.dp))
                    Text("LIVE", style = MaterialTheme.typography.labelSmall, color = Color.White)
                }
            }
        }
        SceneChip(vm, Modifier.align(Alignment.TopEnd).padding(10.dp), dark = true)
        if (!vm.busy && m.frames > 0 && m.frames < 40) {
            Text(
                "Tap to focus",
                Modifier.align(Alignment.BottomCenter).padding(12.dp).clip(CircleShape).background(Color(0x80000000)).padding(horizontal = 10.dp, vertical = 5.dp),
                style = MaterialTheme.typography.labelMedium,
                color = Color.White,
            )
        }
    }
}

/** The AF point: four corner brackets, amber and settling while the camera moves it. */
@Composable
private fun Reticle(at: Offset, focusing: Boolean) {
    val color by animateColorAsState(if (focusing) Palette.Accent else Color.White, tween(250), label = "reticle")
    val s by animateFloatAsState(if (focusing) 1.25f else 1f, spring(dampingRatio = 0.5f, stiffness = 250f), label = "reticleScale")
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val half = with(density) { 28.dp.toPx() }
        val x = at.x * with(density) { maxWidth.toPx() }
        val y = at.y * with(density) { maxHeight.toPx() }
        Canvas(Modifier.offset { IntOffset((x - half).roundToInt(), (y - half).roundToInt()) }.size(56.dp).scale(s)) {
            val w = size.width
            val l = w * 0.28f
            val st = 2.dp.toPx()
            for ((cx, cy) in listOf(0f to 0f, w to 0f, 0f to w, w to w)) {
                val dx = if (cx == 0f) l else -l
                val dy = if (cy == 0f) l else -l
                drawLine(color, Offset(cx, cy), Offset(cx + dx, cy), st, StrokeCap.Round)
                drawLine(color, Offset(cx, cy), Offset(cx, cy + dy), st, StrokeCap.Round)
            }
        }
    }
}

// ------------------------------------------------------------------ dials

@Composable
private fun DialRow(dials: List<Dial>, selected: String?, enabled: Boolean, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        dials.forEach { d ->
            val on = d.key == selected
            val tint by animateColorAsState(
                when {
                    on -> Palette.Accent
                    !d.changeable -> Palette.Faint
                    else -> Palette.Text
                },
                tween(200), label = "dial",
            )
            Column(
                Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).clickable(enabled = enabled) { onSelect(d.key) }.padding(vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(d.label.uppercase(), style = MaterialTheme.typography.labelSmall, color = if (on) Palette.Accent else Palette.Muted, maxLines = 1)
                Spacer(Modifier.height(4.dp))
                val shown = when {
                    d.value.isEmpty() -> d.chosen?.let { ManualCamera.short(d.key, it) } ?: "–"
                    else -> ManualCamera.short(d.key, d.value)
                }
                Text(shown, style = MaterialTheme.typography.titleLarge.merge(Numeric), color = tint, maxLines = 1, softWrap = false)
                // Under the value: the camera's pick for ISO auto, or "auto" for a value the mode chooses.
                val note = when {
                    d.value == "auto" && d.chosen != null -> d.chosen
                    d.value.isEmpty() -> "auto"
                    else -> ManualCamera.unit(d.key).takeIf { it.isNotEmpty() && d.key != "av" }
                }
                Text(note ?: " ", style = MaterialTheme.typography.labelSmall.merge(Numeric), color = Palette.Faint, maxLines = 1)
                Spacer(Modifier.height(4.dp))
                Box(Modifier.width(if (on) 18.dp else 0.dp).height(2.dp).clip(CircleShape).background(Palette.Accent))
            }
        }
    }
}

/** The options of one dial in a row that snaps to the centre; the centred value is applied when it settles. */
@Composable
private fun ValueStrip(dial: Dial, enabled: Boolean, onPick: (String) -> Unit) {
    val options = dial.options
    val index = options.indexOf(dial.value).coerceAtLeast(0)
    val list = rememberLazyListState(index)
    val fling = rememberSnapFlingBehavior(list, SnapPosition.Center)
    val scope = rememberCoroutineScope()
    val dragged by list.interactionSource.collectIsDraggedAsState()
    val value by rememberUpdatedState(dial.value)
    val pick by rememberUpdatedState(onPick)
    var touched by remember { mutableStateOf(false) }
    if (dragged) touched = true
    // The item nearest the middle of the strip.
    fun centred(): Int {
        val info = list.layoutInfo
        val mid = (info.viewportStartOffset + info.viewportEndOffset) / 2
        return info.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2 - mid) }?.index ?: list.firstVisibleItemIndex
    }

    // Settled after a swipe: apply what's in the middle.
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress }.collect { scrolling ->
            if (!scrolling && touched) {
                touched = false
                val i = centred().coerceIn(0, options.lastIndex)
                if (options[i] != value) pick(options[i])
            }
        }
    }
    // The camera changed it (or refused): follow.
    LaunchedEffect(index) {
        if (!list.isScrollInProgress && centred() != index) list.animateScrollToItem(index)
    }

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val itemW = 72.dp
        val side = (maxWidth - itemW) / 2
        // The centre mark.
        Box(Modifier.align(Alignment.Center).width(itemW).height(48.dp).clip(RoundedCornerShape(14.dp)).background(Palette.Raised))
        LazyRow(
            state = list,
            flingBehavior = fling,
            contentPadding = PaddingValues(horizontal = side),
            userScrollEnabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        ) {
            itemsIndexed(options) { i, o ->
                val on = o == dial.value
                Box(
                    Modifier.width(itemW).height(48.dp).clip(RoundedCornerShape(14.dp)).clickable(enabled = enabled) {
                        scope.launch { list.animateScrollToItem(i) }
                        if (!on) onPick(o)
                    },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        ManualCamera.short(dial.key, o),
                        style = MaterialTheme.typography.titleMedium.merge(Numeric).copy(fontSize = if (on) 18.sp else 16.sp),
                        color = if (on) Palette.Accent else Palette.Muted,
                        maxLines = 1,
                        softWrap = false,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

/** The live view's brightness spread as a soft filled curve, with clipped ends marked. */
@Composable
private fun Histogram(bins: IntArray, modifier: Modifier) {
    Canvas(modifier) {
        // Merge into 64 columns and scale against the 98th percentile so one spike doesn't flatten the rest.
        val cols = 64
        val per = bins.size / cols
        val v = FloatArray(cols) { c -> (0 until per).sumOf { bins[c * per + it] }.toFloat() }
        val top = v.sorted()[(cols * 0.98f).toInt().coerceAtMost(cols - 1)].coerceAtLeast(1f)
        val w = size.width
        val h = size.height
        val path = androidx.compose.ui.graphics.Path().apply {
            moveTo(0f, h)
            for (c in 0 until cols) lineTo(w * c / (cols - 1), h - h * (v[c] / top).coerceAtMost(1f))
            lineTo(w, h)
            close()
        }
        drawPath(path, Color.White.copy(alpha = 0.16f))
        drawLine(Palette.Line, Offset(0f, h), Offset(w, h), 1.dp.toPx())
        val total = v.sum().coerceAtLeast(1f)
        if (v[0] / total > 0.02f) drawLine(Palette.Accent, Offset(0f, 0f), Offset(0f, h), 2.dp.toPx())
        if (v[cols - 1] / total > 0.02f) drawLine(Palette.Accent, Offset(w, 0f), Offset(w, h), 2.dp.toPx())
    }
}

// ------------------------------------------------------------------ shutter

@Composable
private fun ShutterRow(m: ManualCamera, enabled: Boolean, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 28.dp), verticalAlignment = Alignment.CenterVertically) {
        // Last shot.
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            val shot = m.lastShot
            AnimatedContent(shot, transitionSpec = { (fadeIn() + scaleIn(initialScale = 0.6f)) togetherWith fadeOut() }, label = "thumb") { s ->
                Box(
                    Modifier.size(56.dp).clip(RoundedCornerShape(16.dp)).background(Palette.Raised).clickable(enabled = s != null, onClick = onOpen),
                ) {
                    if (s != null) Image(s.image, "Last shot", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                }
            }
        }
        Shutter(m.shooting, enabled = enabled && !m.busy) { m.shoot() }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            val on = m.afOnShutter
            Text(
                if (on) "AF" else "MF",
                Modifier.clip(CircleShape).background(if (on) Palette.AccentSoft else Palette.Raised).clickable(enabled = enabled) { m.afOnShutter = !on }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                style = MaterialTheme.typography.labelLarge,
                color = if (on) Palette.Accent else Palette.Muted,
            )
        }
    }
}

/** A ring with a white disc; while the shot is being taken and fetched, an amber arc runs round it. */
@Composable
private fun Shutter(shooting: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val t = rememberInfiniteTransition(label = "shutter")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "spin")
    val inner by animateFloatAsState(if (shooting) 0.62f else 0.8f, spring(dampingRatio = 0.55f, stiffness = 400f), label = "inner")
    Box(
        Modifier.size(80.dp).pressScale(source).clip(CircleShape).clickable(source, null, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize().alpha(if (enabled || shooting) 1f else 0.4f)) {
            val r = size.minDimension / 2
            drawCircle(Color.White.copy(alpha = 0.9f), r - 2.dp.toPx(), style = Stroke(3.dp.toPx()))
            drawCircle(if (shooting) Palette.Accent else Color.White, r * inner)
            if (shooting) drawArc(Palette.Accent, spin, 80f, false, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
        }
    }
}
