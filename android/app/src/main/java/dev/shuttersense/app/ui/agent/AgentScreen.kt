package dev.shuttersense.app.ui.agent

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Bookmark
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Lightbulb
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.shuttersense.app.agent.Idea
import dev.shuttersense.app.agent.StepEntry
import dev.shuttersense.app.agent.StepKind
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.setup.SceneChip
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import dev.shuttersense.app.ui.Numeric
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.ShotApproval
import dev.shuttersense.app.ui.ShotThumb
import dev.shuttersense.app.ui.components.CameraMenuGuide
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.PhotoViewer
import dev.shuttersense.app.ui.components.PrimaryButton
import dev.shuttersense.app.ui.components.RoundIcon
import dev.shuttersense.app.ui.components.SecondaryButton
import dev.shuttersense.app.ui.components.SettingChip
import dev.shuttersense.app.ui.components.Sheet
import dev.shuttersense.app.ui.components.StatusDot
import dev.shuttersense.app.ui.components.TextAction
import dev.shuttersense.app.ui.components.rememberDataUrlImage
import dev.shuttersense.app.ui.connect.switchColors

// The agent, as a conversation: what you asked for on the right, what it did
// as a quiet timeline on the left (thinking, settings changes as chips, test
// shots, questions with their options, the summary), then before and after.

/** A photo opened from the timeline. */
private class Opened(val image: ImageBitmap, val caption: String?)

@Composable
fun AgentScreen(vm: AppViewModel, modifier: Modifier = Modifier, sceneChip: Boolean = true) {
    var opened by remember { mutableStateOf<Opened?>(null) }
    var settings by rememberSaveable { mutableStateOf(false) }
    val list = rememberLazyListState()
    // Follow the newest step; the extra scroll reaches the bottom of a tall last item (a shot, the comparison).
    LaunchedEffect(list) {
        snapshotFlow { Triple(vm.steps.size + (if (vm.approval != null) 1 else 0) + (if (vm.busy) 1 else 0), list.layoutInfo.totalItemsCount, vm.question) }.collectLatest { (n, count, _) ->
            if (n == 0 || count == 0) return@collectLatest
            delay(60) // let new items measure
            list.animateScrollToItem(count - 1)
            repeat(8) { if (list.canScrollForward) list.animateScrollBy(1500f) }
        }
    }

    Column(modifier) {
        StatusLine(vm, sceneChip)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (vm.steps.isEmpty()) {
                EmptyState(vm)
            } else {
                LazyColumn(
                    state = list,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
                ) {
                    items(vm.steps, key = { it.id }) { s ->
                        Box(Modifier.animateItem()) { StepItem(s, vm) { img, cap -> opened = Opened(img, cap) } }
                    }
                    vm.approval?.let { a -> item(key = "approval") { ApprovalCard(a, vm) } }
                    if (vm.busy) item(key = "working") { Working(vm.status) }
                    // Before is the camera's own settings (live view before any change); the first test shot stands in without it.
                    val first = vm.beforeView ?: vm.firstShot
                    val last = vm.lastShot
                    if (!vm.busy && first != null && last != null && last.n > first.n) {
                        item(key = "compare") { Compare(first, last) }
                    }
                    if (!vm.busy && vm.steps.lastOrNull()?.kind in listOf(StepKind.DONE, StepKind.ERROR)) item(key = "new") {
                        Box(Modifier.fillMaxWidth().padding(top = 4.dp), contentAlignment = Alignment.Center) {
                            SecondaryButton("New goal", { vm.newGoal() }, icon = Icons.Rounded.Add, height = 40.dp)
                        }
                    }
                }
            }
        }
        InputBar(vm, onSettings = { settings = true })
    }

    opened?.let { o -> PhotoViewer(o.image, o.caption) { opened = null } }
    if (settings) RunSettingsSheet(vm) { settings = false }
}

// ------------------------------------------------------------------ header

@Composable
private fun StatusLine(vm: AppViewModel, sceneChip: Boolean) {
    val line = vm.exposure ?: return
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(if (vm.busy) Palette.Accent else Palette.Good, pulse = vm.busy, size = 6.dp)
        Spacer(Modifier.width(10.dp))
        AnimatedContent(line, Modifier.weight(1f), transitionSpec = { fadeIn(tween(250)) togetherWith fadeOut(tween(150)) }, label = "exposure") {
            Text(it, style = MaterialTheme.typography.bodySmall.merge(Numeric), color = Palette.Muted, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
        if (sceneChip) SceneChip(vm, Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun EmptyState(vm: AppViewModel) {
    // Sits at the bottom; scrolls when it doesn't fit (a phone on its side).
    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight).fillMaxWidth().padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.Bottom,
        ) {
            Text("What's the shot?", style = MaterialTheme.typography.displaySmall, color = Palette.Text)
            Spacer(Modifier.height(10.dp))
            Text(
                "Describe it the way you'd brief an assistant. It reads the camera, changes the settings and takes test shots.",
                style = MaterialTheme.typography.bodyLarge,
                color = Palette.Muted,
            )
            Spacer(Modifier.height(28.dp))
            Eyebrow("Try")
            Spacer(Modifier.height(10.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                vm.exampleGoals.forEach { g ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(Palette.Surface)
                            .clickable { vm.goal = g; vm.submit() }.padding(horizontal = 18.dp, vertical = 15.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(g, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
                        Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, Modifier.size(18.dp), tint = Palette.Faint)
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}

// ------------------------------------------------------------------ timeline

private fun dotColor(kind: StepKind): Color = when (kind) {
    StepKind.THINK -> Palette.Faint
    StepKind.LOOK -> Palette.Muted
    StepKind.SETTINGS, StepKind.SHOT, StepKind.ASK, StepKind.GUIDE, StepKind.PRESET, StepKind.IDEAS -> Palette.Accent
    StepKind.TELL -> Palette.Text
    StepKind.DONE -> Palette.Good
    StepKind.ERROR -> Palette.Bad
    else -> Palette.Muted
}

@Composable
private fun StepItem(s: StepEntry, vm: AppViewModel, open: (ImageBitmap, String?) -> Unit) {
    when (s.kind) {
        StepKind.GOAL, StepKind.INSTRUCTION, StepKind.ANSWER -> UserBubble(s)
        else -> Rail(dotColor(s.kind)) { AgentStep(s, vm, open) }
    }
}

/** What the photographer said, on the right. */
@Composable
private fun UserBubble(s: StepEntry) {
    Box(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 14.dp), contentAlignment = Alignment.CenterEnd) {
        Column(horizontalAlignment = Alignment.End) {
            if (s.kind == StepKind.ANSWER) Eyebrow("Your answer", Modifier.padding(end = 6.dp, bottom = 4.dp))
            Text(
                s.text,
                Modifier
                    .widthIn(max = 320.dp)
                    .clip(RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp, bottomStart = 22.dp, bottomEnd = 6.dp))
                    .background(if (s.kind == StepKind.GOAL) Palette.Accent else Palette.Raised2)
                    .padding(horizontal = 16.dp, vertical = 11.dp),
                style = MaterialTheme.typography.bodyLarge,
                color = if (s.kind == StepKind.GOAL) Palette.AccentInk else Palette.Text,
            )
        }
    }
}

/** The agent's side: a thin line down the left with a dot per step. */
@Composable
private fun Rail(dot: Color, pulse: Boolean = false, content: @Composable () -> Unit) {
    // The line is drawn behind the row (not measured), so steps may hold pagers and other lazy layouts.
    Row(Modifier.fillMaxWidth().drawBehind {
        val x = 3.5.dp.toPx()
        drawLine(Palette.Line, androidx.compose.ui.geometry.Offset(x, 0f), androidx.compose.ui.geometry.Offset(x, size.height), 1.dp.toPx())
    }) {
        Box(Modifier.width(18.dp)) {
            StatusDot(dot, Modifier.offset(y = 7.dp), pulse = pulse, size = 7.dp)
        }
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f).padding(bottom = 18.dp)) { content() }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgentStep(s: StepEntry, vm: AppViewModel, open: (ImageBitmap, String?) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (s.kind) {
            StepKind.THINK -> Text(s.text, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            StepKind.TELL -> Text(s.text, style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
            StepKind.LOOK -> {
                val img = rememberDataUrlImage(s.image)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (img != null) {
                        Image(
                            img, null,
                            Modifier.height(56.dp).aspectRatio(img.width.toFloat() / img.height).clip(RoundedCornerShape(10.dp)).clickable { open(img, s.text) },
                            contentScale = ContentScale.Crop,
                        )
                        Spacer(Modifier.width(12.dp))
                    }
                    Text(s.text, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
            }
            StepKind.SETTINGS -> {
                Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
                if (s.detail.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    s.detail.forEach { DiffChip(it) }
                }
            }
            StepKind.SHOT -> {
                val img = rememberDataUrlImage(s.image)
                val exposure = s.detail.firstOrNull()
                Box(
                    Modifier.fillMaxWidth().widthIn(max = 460.dp).aspectRatio(img?.let { it.width.toFloat() / it.height } ?: 1.5f)
                        .clip(RoundedCornerShape(16.dp)).background(Palette.Surface)
                        .clickable(enabled = img != null) { img?.let { open(it, listOfNotNull(s.text, exposure).joinToString(" · ")) } },
                ) {
                    if (img != null) Image(img, s.text, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    if (exposure != null) Text(
                        exposure,
                        Modifier.align(Alignment.BottomStart).padding(10.dp).clip(CircleShape).background(Color(0x99000000)).padding(horizontal = 10.dp, vertical = 5.dp),
                        style = MaterialTheme.typography.labelMedium.merge(Numeric),
                        color = Color.White,
                    )
                }
                Text(s.text, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            }
            StepKind.ASK -> {
                Text(s.text, style = MaterialTheme.typography.titleMedium, color = Palette.Text)
                val live = isLive(s, vm)
                if (live && s.detail.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        s.detail.forEach { o -> SecondaryButton(o, { vm.answer(o) }, height = 42.dp) }
                    }
                } else if (live) {
                    Text("Type your answer below.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
            }
            StepKind.GUIDE -> GuideCard(s, isLive(s, vm), vm)
            StepKind.PRESET -> PresetCard(s)
            StepKind.IDEAS -> {
                Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
                IdeaRow(s.ideas, vm, open)
            }
            StepKind.DONE -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Check, null, Modifier.size(16.dp), tint = Palette.Good)
                    Spacer(Modifier.width(6.dp))
                    Eyebrow("Done", color = Palette.Good)
                }
                Text(s.text, style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
            }
            StepKind.ERROR -> Row {
                Icon(Icons.Rounded.ErrorOutline, null, Modifier.size(16.dp).offset(y = 2.dp), tint = Palette.Bad)
                Spacer(Modifier.width(6.dp))
                Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Palette.Bad)
            }
            else -> Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
        }
        s.errors.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Bad) }
    }
}

/** Whether [s] is the question the agent is waiting on. */
private fun isLive(s: StepEntry, vm: AppViewModel) =
    vm.question != null && s == vm.steps.lastOrNull { it.kind == StepKind.ASK || it.kind == StepKind.GUIDE }

/**
 * A setting the API can't reach: the path through the camera's own menus,
 * numbered, with Done / Skip while the agent waits.
 */
@Composable
private fun GuideCard(s: StepEntry, live: Boolean, vm: AppViewModel) {
    StepCard(Icons.Rounded.PhotoCamera, "On the camera", s) {
        Spacer(Modifier.height(18.dp))
        // Camera-style menu screens when the agent gave them; the text steps otherwise.
        if (s.menu.isNotEmpty()) CameraMenuGuide(s.menu, Modifier.fillMaxWidth())
        else s.detail.forEachIndexed { i, step ->
            val lastStep = i == s.detail.lastIndex
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                // Numbers joined by a thin line, like a path.
                Column(Modifier.width(26.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        Modifier.size(24.dp).clip(CircleShape).background(if (lastStep) Palette.Accent else Palette.Raised2),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "${i + 1}",
                            style = MaterialTheme.typography.labelMedium.merge(Numeric),
                            color = if (lastStep) Palette.AccentInk else Palette.Text,
                        )
                    }
                    if (!lastStep) Box(Modifier.width(1.dp).weight(1f).background(Palette.Line))
                }
                Spacer(Modifier.width(14.dp))
                Text(
                    step,
                    Modifier.weight(1f).padding(top = 2.dp, bottom = if (lastStep) 0.dp else 16.dp),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Palette.Text,
                )
            }
        }
        if (live) {
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton("Done", { vm.answer("Done") }, Modifier.weight(1f), icon = Icons.Rounded.Check)
                SecondaryButton("Skip", { vm.answer("Skip") }, Modifier.weight(1f), height = 56.dp)
            }
        }
    }
}

/** A preset the agent saved: its name, what it is for, and its settings. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PresetCard(s: StepEntry) {
    StepCard(Icons.Rounded.Bookmark, "Saved preset", s) {
        if (s.detail.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                s.detail.forEach { SettingChip(it, container = Palette.Raised2) }
            }
        }
    }
}

/** A card in the timeline: an icon and a label, the step's title and text, then [content]. */
@Composable
private fun StepCard(icon: ImageVector, label: String, s: StepEntry, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().widthIn(max = 460.dp).clip(RoundedCornerShape(22.dp)).background(Palette.Raised).padding(20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(28.dp).clip(CircleShape).background(Palette.AccentSoft), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(15.dp), tint = Palette.Accent)
            }
            Spacer(Modifier.width(10.dp))
            Eyebrow(label, color = Palette.Accent)
        }
        Spacer(Modifier.height(14.dp))
        Text(s.title.orEmpty(), style = MaterialTheme.typography.headlineSmall, color = Palette.Text)
        if (s.text.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Text(s.text, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        }
        content()
    }
}

/** Picture ideas side by side, to swipe through; "Try this" tells the agent which one. */
@Composable
private fun IdeaRow(ideas: List<Idea>, vm: AppViewModel, open: (ImageBitmap, String?) -> Unit) {
    LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(ideas) { idea -> IdeaCard(idea, vm, open) }
    }
}

@Composable
private fun IdeaCard(idea: Idea, vm: AppViewModel, open: (ImageBitmap, String?) -> Unit) {
    val img = rememberDataUrlImage(idea.image)
    Column(Modifier.width(220.dp).clip(RoundedCornerShape(18.dp)).background(Palette.Raised)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(0.8f).background(Palette.Raised2)
                .clickable(enabled = img != null) { img?.let { open(it, idea.title) } },
            contentAlignment = Alignment.Center,
        ) {
            if (img != null) Image(img, idea.title, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            // No picture (the image model failed, or is still a placeholder): the idea stands as text.
            else Icon(Icons.Rounded.Lightbulb, null, Modifier.size(28.dp), tint = Palette.Faint)
        }
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(idea.title, style = MaterialTheme.typography.titleMedium, color = Palette.Text)
            if (idea.direction.isNotEmpty()) Text(idea.direction, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
            Spacer(Modifier.height(6.dp))
            SecondaryButton("Try this", { vm.tryIdea(idea) }, Modifier.fillMaxWidth(), height = 40.dp)
        }
    }
}

/** "Aperture f/5.6 → f/2.8" with the new value lit. */
@Composable
private fun DiffChip(line: String) {
    val i = line.indexOf(" → ")
    val text = buildAnnotatedString {
        if (i < 0) append(line) else {
            withStyle(SpanStyle(color = Palette.Muted)) { append(line.substring(0, i)) }
            withStyle(SpanStyle(color = Palette.Faint)) { append("  →  ") }
            withStyle(SpanStyle(color = Palette.Accent)) { append(line.substring(i + 3)) }
        }
    }
    Text(
        text,
        Modifier.clip(RoundedCornerShape(10.dp)).background(Palette.Surface).padding(horizontal = 10.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelMedium.merge(Numeric),
        color = Palette.Text,
    )
}

@Composable
private fun Working(status: String) {
    Rail(Palette.Accent, pulse = true) {
        val t = rememberInfiniteTransition(label = "working")
        val a by t.animateFloat(0.55f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "wa")
        AnimatedContent(status.ifEmpty { "Working…" }, transitionSpec = { (fadeIn() + slideInVertically { it / 3 }) togetherWith fadeOut() }, label = "status") {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = Palette.Accent.copy(alpha = a))
        }
    }
}

@Composable
private fun ApprovalCard(a: ShotApproval, vm: AppViewModel) {
    Column(
        Modifier.fillMaxWidth().padding(bottom = 18.dp).clip(RoundedCornerShape(22.dp)).background(Palette.Raised).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Eyebrow("Ready to shoot", color = Palette.Accent)
        Text("Take shot ${a.n}?", style = MaterialTheme.typography.titleLarge, color = Palette.Text)
        if (a.reason.isNotEmpty()) Text(a.reason, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
            PrimaryButton("Shoot", { vm.approve(true) }, Modifier.weight(1f))
            SecondaryButton("Skip", { vm.approve(false) }, Modifier.weight(1f), height = 56.dp)
        }
    }
}

// ------------------------------------------------------------------ before / after

/** Before (the camera's own settings, or the first shot) and the last shot on top of each other; drag the divider to compare. */
@Composable
private fun Compare(first: ShotThumb, last: ShotThumb) {
    var split by remember { mutableFloatStateOf(0.5f) }
    val before = rememberDataUrlImage(first.image)
    val after = rememberDataUrlImage(last.image)
    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Eyebrow("Before and after")
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(after?.let { it.width.toFloat() / it.height } ?: 1.5f)
                .clip(RoundedCornerShape(18.dp))
                .background(Palette.Surface)
                .pointerInput(Unit) {
                    detectTapGestures { split = (it.x / size.width).coerceIn(0f, 1f) }
                }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures { change, _ -> split = (change.position.x / size.width).coerceIn(0f, 1f) }
                },
        ) {
            if (after != null) Image(after, "After", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            if (before != null) Image(
                before, "Before",
                Modifier.fillMaxSize().drawWithContent { clipRect(right = size.width * split) { this@drawWithContent.drawContent() } },
                contentScale = ContentScale.Crop,
            )
            // The divider and its handle.
            Box(Modifier.fillMaxSize().drawWithContent {
                drawContent()
                val x = size.width * split
                drawLine(Color.White, androidx.compose.ui.geometry.Offset(x, 0f), androidx.compose.ui.geometry.Offset(x, size.height), 2.dp.toPx())
                drawCircle(Color.White, 14.dp.toPx(), androidx.compose.ui.geometry.Offset(x, size.height / 2))
                // Two small arrowheads: drag either way.
                val cy = size.height / 2
                val a = 3.5.dp.toPx()
                for (dir in listOf(-1f, 1f)) {
                    val tip = x + dir * 8.dp.toPx()
                    val base = x + dir * 3.dp.toPx()
                    drawPath(
                        androidx.compose.ui.graphics.Path().apply {
                            moveTo(tip, cy)
                            lineTo(base, cy - a)
                            lineTo(base, cy + a)
                            close()
                        },
                        Palette.Ink,
                    )
                }
            })
            Tag("Before", Modifier.align(Alignment.TopStart))
            Tag("After", Modifier.align(Alignment.TopEnd))
        }
        Row(Modifier.fillMaxWidth()) {
            // The live view before any change has no shot number.
            Text(if (first.n > 0) "Shot ${first.n} · ${first.exposure}" else first.exposure, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.merge(Numeric), color = Palette.Muted)
            Spacer(Modifier.width(12.dp))
            Text("Shot ${last.n} · ${last.exposure}", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.merge(Numeric), color = Palette.Text, textAlign = androidx.compose.ui.text.style.TextAlign.End)
        }
    }
}

@Composable
private fun Tag(text: String, modifier: Modifier) {
    Text(
        text,
        modifier.padding(10.dp).clip(CircleShape).background(Color(0x99000000)).padding(horizontal = 10.dp, vertical = 4.dp),
        style = MaterialTheme.typography.labelMedium,
        color = Color.White,
    )
}

// ------------------------------------------------------------------ input

@Composable
private fun InputBar(vm: AppViewModel, onSettings: () -> Unit) {
    val ctx = LocalContext.current
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) vm.toggleRecording() else vm.notice = "Microphone permission is needed for voice"
    }
    val canSend = vm.goal.isNotBlank()
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 10.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        RoundIcon(Icons.Rounded.Tune, "Run settings", onSettings, size = 48.dp, tint = Palette.Muted)
        Spacer(Modifier.width(4.dp))
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(Palette.Raised).animateContentSize(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.weight(1f).padding(start = 18.dp, top = 12.dp, bottom = 12.dp)) {
                if (vm.recording) {
                    Listening()
                } else {
                    if (vm.goal.isEmpty()) Text(
                        when {
                            vm.transcribing -> "Transcribing…"
                            vm.question != null -> "Type an answer"
                            vm.busy -> "Correct it: “a bit warmer”"
                            vm.started -> "Refine it, or start a new goal"
                            else -> "What shot do you want?"
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        color = Palette.Faint,
                        maxLines = 1,
                    )
                    BasicTextField(
                        vm.goal,
                        { v ->
                            // A hardware Enter sends rather than adding a line.
                            if ('\n' in v && '\n' !in vm.goal) {
                                vm.goal = v.replace("\n", "")
                                vm.send()
                            } else vm.goal = v
                        },
                        Modifier.fillMaxWidth(),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = Palette.Text),
                        cursorBrush = SolidColor(Palette.Accent),
                        maxLines = 4,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { vm.send() }),
                    )
                }
            }
            RoundIcon(
                if (vm.recording) Icons.Rounded.Stop else Icons.Rounded.Mic,
                if (vm.recording) "Stop recording" else "Speak",
                {
                    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) vm.toggleRecording()
                    else mic.launch(Manifest.permission.RECORD_AUDIO)
                },
                Modifier.padding(end = 2.dp),
                size = 44.dp,
                container = if (vm.recording) Palette.Bad else Color.Transparent,
                tint = if (vm.recording) Palette.Ink else Palette.Muted,
                enabled = !vm.transcribing,
                content = if (vm.transcribing) ({ CircularProgressIndicator(Modifier.size(18.dp), color = Palette.Muted, strokeWidth = 2.dp) }) else null,
            )
        }
        Spacer(Modifier.width(8.dp))
        // Send when there's text; while working with an empty box, the same spot cancels.
        val stop = vm.busy && !canSend
        RoundIcon(
            if (stop) Icons.Rounded.Stop else Icons.Rounded.ArrowUpward,
            if (stop) "Cancel" else "Send",
            { if (stop) vm.cancel() else vm.send() },
            size = 48.dp,
            container = when {
                stop -> Palette.Raised2
                canSend -> Palette.Accent
                else -> Palette.Raised
            },
            tint = when {
                stop -> Palette.Text
                canSend -> Palette.AccentInk
                else -> Palette.Faint
            },
            enabled = stop || canSend,
        )
    }
}

/** Three bars that bounce while recording. */
@Composable
private fun Listening() {
    val t = rememberInfiniteTransition(label = "listen")
    Row(verticalAlignment = Alignment.CenterVertically) {
        repeat(4) { i ->
            val h by t.animateFloat(5f, 18f, infiniteRepeatable(tween(420, delayMillis = i * 90), RepeatMode.Reverse), label = "bar$i")
            Box(Modifier.padding(end = 3.dp).width(3.dp).height(h.dp).clip(CircleShape).background(Palette.Bad))
        }
        Spacer(Modifier.width(10.dp))
        Text("Listening… tap stop when done", style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
    }
}

// ------------------------------------------------------------------ run settings

@Composable
private fun RunSettingsSheet(vm: AppViewModel, onDismiss: () -> Unit) {
    Sheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text("Run settings", style = MaterialTheme.typography.titleLarge, color = Palette.Text)
            Spacer(Modifier.height(12.dp))
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable {
                    vm.askBeforeShooting = !vm.askBeforeShooting
                    vm.saveSettings()
                }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Ask before each shot", style = MaterialTheme.typography.bodyLarge)
                    Text("You approve every test shot", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
                Switch(vm.askBeforeShooting, { vm.askBeforeShooting = it; vm.saveSettings() }, colors = switchColors())
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Test shots per goal", style = MaterialTheme.typography.bodyLarge)
                    Text("Corrections afterwards get 3 more", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
                Row(Modifier.clip(CircleShape).background(Palette.Raised), verticalAlignment = Alignment.CenterVertically) {
                    TextAction("–", { if (vm.maxShots > 1) vm.maxShots--; vm.saveSettings() }, color = Palette.Text)
                    Text("${vm.maxShots}", Modifier.width(24.dp), style = MaterialTheme.typography.titleMedium.merge(Numeric), color = Palette.Text, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    TextAction("+", { if (vm.maxShots < 10) vm.maxShots++; vm.saveSettings() }, color = Palette.Text)
                }
            }
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable {
                    onDismiss()
                    vm.showPresets = true
                }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Saved presets", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        if (vm.presets.isEmpty()) "Say “save this as club night” to keep a setup" else "${vm.presets.size} saved · use one or delete it",
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.Muted,
                    )
                }
                Icon(Icons.Rounded.ChevronRight, null, tint = Palette.Faint)
            }
            if (vm.started && !vm.busy) {
                Spacer(Modifier.height(12.dp))
                SecondaryButton("Start a new goal", { vm.newGoal(); onDismiss() }, Modifier.fillMaxWidth(), height = 52.dp)
            }
            if (vm.busy) {
                Spacer(Modifier.height(12.dp))
                Text("Changes apply to the next goal.", style = MaterialTheme.typography.bodySmall, color = Palette.Faint)
            }
        }
    }
}
