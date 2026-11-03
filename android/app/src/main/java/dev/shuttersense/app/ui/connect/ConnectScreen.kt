package dev.shuttersense.app.ui.connect

import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import dev.shuttersense.app.net.CameraWifi
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.ccapi.FoundCamera
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.CameraStatus
import dev.shuttersense.app.ui.EMULATOR_WORKER
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.Field
import dev.shuttersense.app.ui.components.PrimaryButton
import dev.shuttersense.app.ui.components.RoundIcon
import dev.shuttersense.app.ui.components.StatusDot
import dev.shuttersense.app.ui.components.TextAction
import kotlinx.coroutines.delay

// Connect the camera: cameras found on the Wi-Fi to tap, or the address by
// hand, with login, HTTPS and the agent server under Advanced. The main
// screens open only once the camera answers.

@Composable
fun ConnectScreen(vm: AppViewModel) {
    LaunchedEffect(Unit) { if (vm.camera !is CameraStatus.Connected) vm.searchCameras() }
    // A fresh connection moves on by itself after a moment; coming back here doesn't.
    var sawConnecting by remember { mutableStateOf(false) }
    LaunchedEffect(vm.camera) {
        when (vm.camera) {
            is CameraStatus.Connecting -> sawConnecting = true
            is CameraStatus.Connected -> if (sawConnecting) {
                delay(1100)
                vm.enterMain()
            }
            else -> {}
        }
    }

    Box(
        Modifier.fillMaxSize().background(Palette.Ink).windowInsetsPadding(WindowInsets.safeDrawing).imePadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        ) {
            BackHandler { vm.openChooser() }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", { vm.openChooser() }, Modifier.padding(end = 4.dp), tint = Palette.Text)
                Text("Shutter Sense", style = MaterialTheme.typography.titleMedium, color = Palette.Text, modifier = Modifier.weight(1f))
                RoundIcon(Icons.AutoMirrored.Rounded.HelpOutline, "How it works", { vm.openWelcome() }, tint = Palette.Muted)
            }
            Spacer(Modifier.height(40.dp))
            AnimatedContent(
                vm.camera.stage(),
                transitionSpec = { fadeIn(tween(260, 80)) togetherWith fadeOut(tween(160)) },
                label = "connect",
            ) { stage ->
                when (stage) {
                    Stage.FORM -> Form(vm)
                    Stage.CONNECTING -> Connecting("${vm.host.trim()}:${vm.port.trim()}")
                    Stage.CONNECTED -> (vm.camera as? CameraStatus.Connected)?.let { Connected(it, vm) } ?: Box(Modifier)
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

private enum class Stage { FORM, CONNECTING, CONNECTED }

private fun CameraStatus.stage() = when (this) {
    is CameraStatus.Connecting -> Stage.CONNECTING
    is CameraStatus.Connected -> Stage.CONNECTED
    else -> Stage.FORM
}

@Composable
private fun Form(vm: AppViewModel) {
    var advanced by rememberSaveable { mutableStateOf(false) }
    Column {
        Text("Connect your camera", style = MaterialTheme.typography.displaySmall, color = Palette.Text)
        Spacer(Modifier.height(12.dp))
        Text(
            "Turn on remote control (CCAPI) on the camera. Then join the camera's own Wi-Fi below, just for this app, or put camera and phone on the same Wi-Fi.",
            style = MaterialTheme.typography.bodyLarge,
            color = Palette.Muted,
        )
        Spacer(Modifier.height(32.dp))

        CameraWifiCard(vm)
        Spacer(Modifier.height(28.dp))

        Nearby(vm)
        Spacer(Modifier.height(28.dp))

        Eyebrow("Address")
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Field(vm.host, { vm.host = it.trim() }, "Camera IP", Modifier.weight(1f), placeholder = "192.168.1.2", keyboardType = KeyboardType.Uri, onDone = { vm.connect() })
            Field(vm.port, { vm.port = it.filter(Char::isDigit).take(5) }, "Port", Modifier.width(96.dp), placeholder = "8080", keyboardType = KeyboardType.Number, onDone = { vm.connect() })
        }

        val failed = vm.camera as? CameraStatus.Failed
        AnimatedVisibility(failed != null, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            var last by remember { mutableStateOf("") }
            failed?.let { last = it.message }
            Row(
                Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Bad.copy(alpha = 0.10f)).padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(Icons.Rounded.ErrorOutline, null, Modifier.size(20.dp), tint = Palette.Bad)
                Spacer(Modifier.width(10.dp))
                Text(last, style = MaterialTheme.typography.bodyMedium, color = Palette.Text)
            }
        }

        Spacer(Modifier.height(8.dp))
        val rot by animateFloatAsState(if (advanced) 180f else 0f, spring(stiffness = 400f), label = "chev")
        Row(
            Modifier.clip(CircleShape).clickable { advanced = !advanced }.padding(start = 4.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Advanced", style = MaterialTheme.typography.labelLarge, color = Palette.Muted)
            Spacer(Modifier.width(2.dp))
            Icon(Icons.Rounded.ExpandMore, null, Modifier.size(20.dp).rotate(rot), tint = Palette.Muted)
        }
        AnimatedVisibility(advanced, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Raised).clickable { vm.https = !vm.https }.padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("HTTPS", style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
                        Text("Trusts the camera's own certificate", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                    }
                    Switch(vm.https, { vm.https = it }, colors = switchColors())
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Field(vm.username, { vm.username = it }, "Username", Modifier.weight(1f), placeholder = "Optional")
                    Field(vm.password, { vm.password = it }, "Password", Modifier.weight(1f), placeholder = "Optional", password = true)
                }
                Field(vm.workerUrl, { vm.workerUrl = it.trim() }, "Agent server", Modifier.fillMaxWidth(), keyboardType = KeyboardType.Uri)
                Text(
                    "The worker that talks to the model. Emulator with a local worker: $EMULATOR_WORKER",
                    Modifier.padding(horizontal = 4.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Faint,
                )
            }
        }

        Spacer(Modifier.height(20.dp))
        PrimaryButton(if (vm.camera is CameraStatus.Failed) "Try again" else "Connect", { vm.connect() }, Modifier.fillMaxWidth(), enabled = vm.host.isNotBlank())
    }
}

/** Joins the camera's own Wi-Fi for this app only; the rest of the phone keeps its connection. */
@Composable
private fun CameraWifiCard(vm: AppViewModel) {
    var pass by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Eyebrow("Camera Wi-Fi")
        val joined = vm.cameraWifi
        when {
            !CameraWifi.supported -> Text(
                "Join the camera's Wi-Fi in your phone's settings, then come back.",
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.Muted,
            )
            joined != null -> Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Raised).padding(horizontal = 16.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Wifi, null, Modifier.size(20.dp), tint = Palette.Accent)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(joined, style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
                    Text("Joined for this app only. Other apps keep your connection.", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
                }
                TextAction("Leave", { vm.leaveWifi() }, color = Palette.Muted)
            }
            else -> {
                Text(
                    "Using the camera's own Wi-Fi? Enter the network name and password the camera shows, and join it just for this app. The rest of the phone stays on your current connection.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.Muted,
                )
                Field(vm.wifiName, { vm.wifiName = it }, "Network name (SSID)", Modifier.fillMaxWidth(), placeholder = "EOSR6m2-…")
                Field(pass, { pass = it }, "Password", Modifier.fillMaxWidth(), password = true, onDone = { vm.joinWifi(pass) })
                val joining = vm.joiningWifi != null
                PrimaryButton(
                    if (joining) "Waiting for Android…" else "Join camera Wi-Fi",
                    { vm.joinWifi(pass) },
                    Modifier.fillMaxWidth(),
                    enabled = !joining && vm.wifiName.isNotBlank() && (pass.isEmpty() || pass.length >= 8),
                )
            }
        }
        vm.wifiError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Palette.Bad) }
    }
}

@Composable
private fun Nearby(vm: AppViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Eyebrow("On this network", Modifier.weight(1f))
            if (vm.searching) CircularProgressIndicator(Modifier.size(14.dp), color = Palette.Muted, strokeWidth = 1.5.dp)
            else TextAction("Search again", { vm.searchCameras() }, color = Palette.Accent)
        }
        when {
            vm.found.isNotEmpty() -> vm.found.forEach { FoundRow(it) { vm.useFound(it) } }
            vm.searching -> Text("Looking for cameras…", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            else -> Text("None found. Enter the camera's address below.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        }
    }
}

@Composable
private fun FoundRow(c: FoundCamera, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Palette.Raised).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(Palette.Raised2), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.PhotoCamera, null, Modifier.size(18.dp), tint = Palette.Accent)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(c.name, style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
            Text("${c.host}:${c.port}${if (c.https) " · HTTPS" else ""}", style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        }
        Icon(Icons.Rounded.ChevronRight, null, tint = Palette.Muted)
    }
}

@Composable
private fun Connecting(where: String) {
    val t = rememberInfiniteTransition(label = "connecting")
    val sweep by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "sweep")
    val breathe by t.animateFloat(0.94f, 1.04f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "breathe")
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(128.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                drawCircle(Palette.Raised, style = Stroke(3.dp.toPx()))
                drawArc(Palette.Accent, sweep, 70f, false, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
            }
            Box(Modifier.size(80.dp).scale(breathe).clip(CircleShape).background(Palette.Raised), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PhotoCamera, null, Modifier.size(34.dp), tint = Palette.Accent)
            }
        }
        Spacer(Modifier.height(32.dp))
        Text("Connecting…", style = MaterialTheme.typography.headlineMedium, color = Palette.Text)
        Spacer(Modifier.height(8.dp))
        Text(where, style = MaterialTheme.typography.bodyLarge, color = Palette.Muted)
    }
}

@Composable
private fun Connected(c: CameraStatus.Connected, vm: AppViewModel) {
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    val pop by animateFloatAsState(if (shown) 1f else 0.6f, spring(dampingRatio = 0.45f, stiffness = 300f), label = "pop")
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(96.dp).scale(pop).clip(CircleShape).background(Palette.Good.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Check, null, Modifier.size(44.dp), tint = Palette.Good)
        }
        Spacer(Modifier.height(32.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(Palette.Good)
            Spacer(Modifier.width(8.dp))
            Eyebrow("Connected", color = Palette.Good)
        }
        Spacer(Modifier.height(10.dp))
        Text(c.model, style = MaterialTheme.typography.headlineMedium, color = Palette.Text, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(c.lens ?: "No lens reported", style = MaterialTheme.typography.bodyLarge, color = Palette.Muted)
        Spacer(Modifier.height(40.dp))
        PrimaryButton("Continue", { vm.enterMain() }, Modifier.fillMaxWidth())
        Spacer(Modifier.height(4.dp))
        TextAction("Use another camera", { vm.disconnect() })
    }
}

@Composable
fun switchColors() = SwitchDefaults.colors(
    checkedThumbColor = Palette.AccentInk,
    checkedTrackColor = Palette.Accent,
    checkedBorderColor = Palette.Accent,
    uncheckedThumbColor = Palette.Muted,
    uncheckedTrackColor = Palette.Raised2,
    uncheckedBorderColor = Palette.Raised2,
)
