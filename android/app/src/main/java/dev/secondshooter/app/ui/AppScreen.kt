package dev.secondshooter.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.QuestionAnswer
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import dev.secondshooter.app.agent.StepEntry
import dev.secondshooter.app.agent.StepKind
import dev.secondshooter.app.glasses.RoomState
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppScreen(vm: AppViewModel) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(vm.notice) {
        vm.notice?.let {
            snackbar.showSnackbar(it)
            vm.notice = null
        }
    }
    val list = rememberLazyListState()
    LaunchedEffect(vm.steps.size) {
        if (vm.steps.isNotEmpty()) list.animateScrollToItem(list.layoutInfo.totalItemsCount.coerceAtLeast(1) - 1)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Second Shooter", fontWeight = FontWeight.SemiBold)
                        Text("Say the shot. It works the camera.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                actions = {
                    TextButton(onClick = { vm.openGlasses() }) {
                        Icon(Icons.Filled.Visibility, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (vm.glassesOnline > 0) "Glasses on" else "Glasses")
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxSize().padding(pad).imePadding(),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { CameraCard(vm) }
            item { GoalCard(vm) }
            vm.approval?.let { a -> item { ApprovalCard(a, vm) } }
            vm.question?.let { q -> item { QuestionCard(q, vm) } }
            val first = vm.firstShot
            val last = vm.lastShot
            if (first != null && last != null && last.n > first.n) item { BeforeAfter(first, last) }
            if (vm.steps.isNotEmpty()) item {
                Text("Steps", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
            items(vm.steps, key = { it.id }) { StepRow(it, vm) }
        }
    }
    if (vm.showGlasses) GlassesSheet(vm)
}

// ------------------------------------------------------------------ camera

@Composable
private fun CameraCard(vm: AppViewModel) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (val c = vm.camera) {
                is CameraStatus.Connected -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(Color(0xFF4CD964)))
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(c.name, fontWeight = FontWeight.Medium)
                            vm.exposure?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        TextButton(onClick = { vm.disconnect() }) { Text("Disconnect") }
                    }
                }
                else -> ConnectForm(vm, c)
            }
        }
    }
}

@Composable
private fun ConnectForm(vm: AppViewModel, status: CameraStatus) {
    var advanced by rememberSaveable { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Filled.CameraAlt, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(8.dp))
        Text("Connect your camera", style = MaterialTheme.typography.titleMedium)
    }
    Text(
        "Camera on the same Wi-Fi with CCAPI enabled. No camera? Run `npm run sim` on a computer on this network and enter its IP.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            vm.host, { vm.host = it }, Modifier.weight(1f), label = { Text("Camera IP") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        OutlinedTextField(
            vm.port, { vm.port = it.filter(Char::isDigit).take(5) }, Modifier.width(96.dp), label = { Text("Port") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
    }
    TextButton(onClick = { advanced = !advanced }, contentPadding = PaddingValues(0.dp)) {
        Icon(Icons.Filled.Tune, null, Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text(if (advanced) "Hide connection options" else "HTTPS, login, server")
    }
    if (advanced) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("HTTPS (self-signed camera certificate)", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            Switch(vm.https, { vm.https = it })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(vm.username, { vm.username = it }, Modifier.weight(1f), label = { Text("Username") }, singleLine = true)
            OutlinedTextField(
                vm.password, { vm.password = it }, Modifier.weight(1f), label = { Text("Password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
        }
        OutlinedTextField(
            vm.workerUrl, { vm.workerUrl = it }, Modifier.fillMaxWidth(), label = { Text("Agent server") }, singleLine = true,
            supportingText = { Text("Emulator + local `npm run dev:worker`: $EMULATOR_WORKER") },
        )
    }
    if (status is CameraStatus.Failed) Text(status.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    Button(onClick = { vm.connect() }, enabled = status !is CameraStatus.Connecting, modifier = Modifier.fillMaxWidth()) {
        if (status is CameraStatus.Connecting) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
            Text("Connecting…")
        } else Text("Connect")
    }
}

// ------------------------------------------------------------------ goal

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GoalCard(vm: AppViewModel) {
    val ctx = LocalContext.current
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) vm.toggleRecording() else vm.notice = "Microphone permission is needed for voice"
    }
    val started = vm.steps.any { it.kind == StepKind.GOAL }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = vm.goal,
                    onValueChange = { vm.goal = it },
                    modifier = Modifier.weight(1f),
                    placeholder = {
                        Text(
                            when {
                                vm.question != null -> "Type an answer"
                                vm.busy -> "Correct it: \"a bit warmer\""
                                started -> "Refine it, or start a new goal"
                                else -> "What shot do you want?"
                            },
                        )
                    },
                    maxLines = 3,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { if (vm.question != null) vm.answer(vm.goal.also { vm.goal = "" }) else vm.submit() }),
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = {
                        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) vm.toggleRecording()
                        else mic.launch(Manifest.permission.RECORD_AUDIO)
                    },
                    enabled = !vm.transcribing,
                    colors = if (vm.recording) IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error) else IconButtonDefaults.filledIconButtonColors(),
                ) {
                    when {
                        vm.transcribing -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        vm.recording -> Icon(Icons.Filled.Stop, "Stop recording")
                        else -> Icon(Icons.Filled.Mic, "Speak")
                    }
                }
                IconButton(onClick = { if (vm.question != null) vm.answer(vm.goal.also { vm.goal = "" }) else vm.submit() }, enabled = vm.goal.isNotBlank()) {
                    Icon(Icons.AutoMirrored.Filled.Send, "Send")
                }
            }
            if (vm.recording) Text("Listening… tap stop when you're done.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)

            if (!vm.busy && !started) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    EXAMPLE_GOALS.forEach { g -> AssistChip(onClick = { vm.goal = g; vm.submit() }, label = { Text(g) }) }
                }
            }

            if (vm.busy) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text(vm.status.ifEmpty { "Working…" }, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { vm.cancel() }) { Text("Cancel") }
                }
            } else {
                HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Ask before each shot", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Switch(vm.askBeforeShooting, { vm.askBeforeShooting = it; vm.saveSettings() })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Test shots per goal", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    IconButton(onClick = { if (vm.maxShots > 1) vm.maxShots-- ; vm.saveSettings() }) { Icon(Icons.Filled.Remove, "Fewer") }
                    Text("${vm.maxShots}", fontWeight = FontWeight.SemiBold)
                    IconButton(onClick = { if (vm.maxShots < 10) vm.maxShots++ ; vm.saveSettings() }) { Icon(Icons.Filled.Add, "More") }
                }
                if (started) OutlinedButton(onClick = { vm.newGoal() }, modifier = Modifier.fillMaxWidth()) { Text("New goal") }
            }
        }
    }
}

@Composable
private fun ApprovalCard(a: ShotApproval, vm: AppViewModel) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Take shot ${a.n}?", style = MaterialTheme.typography.titleMedium)
            if (a.reason.isNotEmpty()) Text(a.reason, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.approve(true) }) { Text("Shoot") }
                OutlinedButton(onClick = { vm.approve(false) }) { Text("Skip") }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuestionCard(q: Question, vm: AppViewModel) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(q.text, style = MaterialTheme.typography.titleMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                q.options.forEach { o -> Button(onClick = { vm.answer(o) }) { Text(o) } }
            }
            Text("Or type an answer above.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun BeforeAfter(first: ShotThumb, last: ShotThumb) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for ((label, t) in listOf("Before · shot ${first.n}" to first, "After · shot ${last.n}" to last)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(label, style = MaterialTheme.typography.labelLarge)
                    Image(
                        t.bitmap.asImageBitmap(), label,
                        Modifier.fillMaxWidth().aspectRatio(t.bitmap.width.toFloat() / t.bitmap.height).clip(RoundedCornerShape(8.dp)),
                        contentScale = ContentScale.Crop,
                    )
                    Text(t.exposure, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

// ------------------------------------------------------------------ step log

private fun iconFor(kind: StepKind): ImageVector = when (kind) {
    StepKind.GOAL -> Icons.Filled.Flag
    StepKind.THINK -> Icons.Filled.Psychology
    StepKind.LOOK -> Icons.Filled.Visibility
    StepKind.SETTINGS -> Icons.Filled.Tune
    StepKind.SHOT -> Icons.Filled.PhotoCamera
    StepKind.TELL -> Icons.Filled.Lightbulb
    StepKind.ASK, StepKind.ANSWER -> Icons.Filled.QuestionAnswer
    StepKind.INSTRUCTION -> Icons.Filled.RecordVoiceOver
    StepKind.DONE -> Icons.Filled.CheckCircle
    StepKind.ERROR -> Icons.Filled.ErrorOutline
}

@Composable
private fun StepRow(s: StepEntry, vm: AppViewModel) {
    val color = when (s.kind) {
        StepKind.ERROR -> MaterialTheme.colorScheme.error
        StepKind.DONE -> Color(0xFF4CD964)
        StepKind.GOAL, StepKind.INSTRUCTION -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val container = when (s.kind) {
        StepKind.DONE -> MaterialTheme.colorScheme.surfaceContainerHigh
        else -> MaterialTheme.colorScheme.surface
    }
    Card(colors = CardDefaults.cardColors(containerColor = container)) {
        Row(Modifier.padding(12.dp)) {
            Icon(iconFor(s.kind), null, tint = color, modifier = Modifier.size(20.dp).padding(top = 2.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val label = when (s.kind) {
                    StepKind.GOAL -> "Goal"
                    StepKind.INSTRUCTION -> "You"
                    StepKind.ANSWER -> "Your answer"
                    StepKind.DONE -> "Done"
                    else -> null
                }
                label?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = color) }
                Text(
                    s.text,
                    style = if (s.kind == StepKind.THINK) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
                    color = if (s.kind == StepKind.THINK) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                if (s.kind == StepKind.ASK && vm.question != null && s == vm.steps.lastOrNull { it.kind == StepKind.ASK }) {
                    // Options are answered in the question card.
                } else if (s.detail.isNotEmpty()) {
                    s.detail.forEach { d ->
                        Text(d, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = MaterialTheme.colorScheme.secondary)
                    }
                }
                s.errors.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                s.image?.let { url ->
                    val bmp = remember(url) { decodeDataUrl(url) }
                    bmp?.let {
                        Image(
                            it.asImageBitmap(), null,
                            Modifier.fillMaxWidth(if (s.kind == StepKind.LOOK) 0.5f else 1f).aspectRatio(it.width.toFloat() / it.height).clip(RoundedCornerShape(8.dp)),
                            contentScale = ContentScale.Crop,
                        )
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ glasses

private val ARROWS = mapOf('U' to "↑", 'D' to "↓", 'L' to "←", 'R' to "→")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun GlassesSheet(vm: AppViewModel) {
    ModalBottomSheet(onDismissRequest = { vm.showGlasses = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Connect glasses", style = MaterialTheme.typography.titleLarge)
            Text(
                "On Ray-Ban Display, open the Second Shooter web app and swipe these arrows with the Neural Band. The lens then shows each step, the settings changes and the last shot; say a correction and it reaches the agent.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val p = vm.pattern
            when {
                vm.roomState != RoomState.ONLINE && p == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(10.dp))
                    Text("Starting a session…")
                }
                p != null -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                        p.forEach { c ->
                            Box(
                                Modifier.size(36.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primaryContainer),
                                contentAlignment = Alignment.Center,
                            ) { Text(ARROWS[c] ?: "?", fontSize = 22.sp, color = MaterialTheme.colorScheme.onPrimaryContainer, fontWeight = FontWeight.Bold) }
                        }
                    }
                    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
                    LaunchedEffect(p) {
                        while (true) {
                            now = System.currentTimeMillis()
                            delay(1000)
                        }
                    }
                    val left = ((vm.patternExpires - now) / 1000).coerceAtLeast(0)
                    Text("Works once · expires in ${left / 60}:${"%02d".format(left % 60)}", style = MaterialTheme.typography.bodySmall)
                }
                else -> Text(
                    if (vm.glassesOnline > 0) "Glasses connected." else "Waiting for the glasses…",
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(10.dp).clip(CircleShape).background(if (vm.glassesOnline > 0) Color(0xFF4CD964) else Color.Gray))
                Spacer(Modifier.width(8.dp))
                Text(if (vm.glassesOnline > 0) "${vm.glassesOnline} glasses online" else "No glasses online yet", style = MaterialTheme.typography.bodyMedium)
            }
            OutlinedButton(onClick = { vm.openGlasses() }, modifier = Modifier.fillMaxWidth().height(44.dp)) { Text("New pattern") }
        }
    }
}
