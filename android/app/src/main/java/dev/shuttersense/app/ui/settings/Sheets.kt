package dev.shuttersense.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Bookmark
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.shuttersense.app.agent.Preset
import dev.shuttersense.app.agent.presetLines
import dev.shuttersense.app.glasses.RoomState
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.CameraStatus
import dev.shuttersense.app.ui.Numeric
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.Tab
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.Field
import dev.shuttersense.app.ui.components.GlassesGlyph
import dev.shuttersense.app.ui.components.SecondaryButton
import dev.shuttersense.app.ui.components.SettingChip
import dev.shuttersense.app.ui.components.Sheet
import dev.shuttersense.app.ui.components.StatusDot
import dev.shuttersense.app.ui.components.TextAction
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.delay

// The sheets off the top bar: the menu (camera, glasses, presets, agent
// server, how it works, about), the saved presets and glasses pairing.

@Composable
fun SettingsSheet(vm: AppViewModel, onDismiss: () -> Unit) {
    // Every way out keeps an edited agent server URL.
    val close = {
        vm.saveSettings()
        onDismiss()
    }
    Sheet(close) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 28.dp)) {
            val c = vm.camera as? CameraStatus.Connected
            Eyebrow("Camera")
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (c != null) Palette.Good else Palette.Faint)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(c?.model ?: "Not connected", style = MaterialTheme.typography.titleLarge, color = Palette.Text)
                    val scene = vm.scenes.firstOrNull { it.id == vm.sceneId }?.title
                    Text(
                        if (vm.demo) listOfNotNull("Simulated on this phone", scene).joinToString(" · ")
                        else listOfNotNull(c?.lens, "${vm.host}:${vm.port}${if (vm.https) " · HTTPS" else ""}").joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = Palette.Muted,
                    )
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Switch camera", { close(); vm.openChooser() }, Modifier.weight(1f), icon = Icons.Rounded.SwapHoriz)
                if (!vm.demo) SecondaryButton("Disconnect", { close(); vm.disconnect() }, Modifier.weight(1f), icon = Icons.Rounded.LinkOff)
            }

            Spacer(Modifier.height(28.dp))
            Eyebrow("More")
            Spacer(Modifier.height(6.dp))
            MenuRow(null, "Glasses", if (vm.glassesOnline > 0) "${vm.glassesOnline} connected" else "Pair Ray-Ban Display", { close(); vm.openGlasses() }) {
                GlassesGlyph(Palette.Text, size = 22.dp)
            }
            MenuRow(
                Icons.Rounded.Bookmark,
                "Presets",
                if (vm.presets.isEmpty()) "None saved yet" else "${vm.presets.size} saved",
                { close(); vm.showPresets = true },
            )
            MenuRow(Icons.AutoMirrored.Rounded.HelpOutline, "How it works", "The welcome tour", { close(); vm.openWelcome() })

            Spacer(Modifier.height(22.dp))
            Eyebrow("Agent server")
            Spacer(Modifier.height(10.dp))
            Field(vm.workerUrl, { vm.workerUrl = it.trim() }, "URL", Modifier.fillMaxWidth(), keyboardType = KeyboardType.Uri)

            Spacer(Modifier.height(28.dp))
            Text("Shutter Sense 0.1", style = MaterialTheme.typography.titleSmall, color = Palette.Text)
            Spacer(Modifier.height(4.dp))
            Text(
                "An agent that works your camera for you. Works with cameras that support CCAPI. " +
                    "The model runs behind the agent server; the camera only talks to this phone.",
                style = MaterialTheme.typography.bodySmall,
                color = Palette.Muted,
            )
        }
    }
}

@Composable
private fun MenuRow(icon: ImageVector?, title: String, sub: String, onClick: () -> Unit, glyph: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable(onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(Palette.Raised), contentAlignment = Alignment.Center) {
            if (glyph != null) glyph() else if (icon != null) Icon(icon, null, Modifier.size(20.dp), tint = Palette.Text)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = Palette.Muted)
        }
        Icon(Icons.Rounded.ChevronRight, null, tint = Palette.Faint)
    }
}

// ------------------------------------------------------------------ presets

@Composable
fun PresetsSheet(vm: AppViewModel) {
    Sheet({ vm.showPresets = false }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 32.dp)) {
            Text("Presets", style = MaterialTheme.typography.headlineSmall, color = Palette.Text)
            Spacer(Modifier.height(8.dp))
            Text(
                "Camera setups the agent saved for you. Use one and the agent applies it, then walks you through anything set by hand.",
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.Muted,
            )
            Spacer(Modifier.height(20.dp))
            if (vm.presets.isEmpty()) {
                Text(
                    "None yet. Once a shot looks right, say “save this as club night”; later, “use my club night preset”.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.Faint,
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                // Newest first.
                vm.presets.asReversed().forEach { p -> PresetRow(p, vm) }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PresetRow(p: Preset, vm: AppViewModel) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Palette.Raised).padding(18.dp)) {
        Text(p.name, style = MaterialTheme.typography.titleLarge, color = Palette.Text)
        if (p.note.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(p.note, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        }
        val lines = presetLines(p)
        if (lines.isNotEmpty()) {
            Spacer(Modifier.height(12.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                lines.forEach { SettingChip(it, container = Palette.Raised2) }
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            SecondaryButton(
                "Use",
                {
                    vm.showPresets = false
                    vm.tab = Tab.AGENT
                    vm.usePreset(p)
                },
                Modifier.weight(1f),
                icon = Icons.Rounded.PlayArrow,
                height = 44.dp,
            )
            Spacer(Modifier.width(8.dp))
            TextAction("Delete", { vm.deletePreset(p) }, color = Palette.Bad, icon = Icons.Rounded.DeleteOutline)
        }
    }
}

// ------------------------------------------------------------------ glasses

private val ARROWS = mapOf('U' to "↑", 'D' to "↓", 'L' to "←", 'R' to "→")

@Composable
fun GlassesSheet(vm: AppViewModel) {
    Sheet({ vm.showGlasses = false }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 32.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                GlassesGlyph(Palette.Accent, size = 26.dp)
                Spacer(Modifier.width(12.dp))
                Text("Pair your glasses", style = MaterialTheme.typography.headlineSmall, color = Palette.Text)
            }
            Spacer(Modifier.height(10.dp))
            Text(
                "On Ray-Ban Display, open the Shutter Sense web app and swipe these arrows with the Neural Band. The lens then follows each step; say a correction and it reaches the agent.",
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.Muted,
            )
            Spacer(Modifier.height(24.dp))
            val p = vm.pattern
            when {
                vm.roomState != RoomState.ONLINE && p == null -> Row(Modifier.height(64.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Palette.Accent, strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp))
                    Text("Starting a session…", style = MaterialTheme.typography.bodyLarge, color = Palette.Text)
                }
                p != null -> {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        p.forEach { c ->
                            Box(
                                Modifier.weight(1f).aspectRatio(0.8f).clip(RoundedCornerShape(12.dp)).background(Palette.Raised2),
                                contentAlignment = Alignment.Center,
                            ) { Text(ARROWS[c] ?: "?", fontSize = 24.sp, color = Palette.Accent) }
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
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Works once · expires in ${left / 60}:${"%02d".format(left % 60)}",
                        Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.bodySmall.merge(Numeric),
                        color = Palette.Muted,
                        textAlign = TextAlign.Center,
                    )
                }
                else -> Text(
                    if (vm.glassesOnline > 0) "Glasses connected." else "Waiting for the glasses…",
                    style = MaterialTheme.typography.titleMedium,
                    color = Palette.Text,
                )
            }
            Spacer(Modifier.height(24.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (vm.glassesOnline > 0) Palette.Good else Palette.Faint, pulse = vm.glassesOnline == 0)
                Spacer(Modifier.width(10.dp))
                Text(
                    if (vm.glassesOnline > 0) "${vm.glassesOnline} glasses online" else "No glasses online yet",
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.Text,
                )
                SecondaryButton("New pattern", { vm.openGlasses() }, height = 40.dp)
            }
        }
    }
}
