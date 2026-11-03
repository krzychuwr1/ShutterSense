package dev.shuttersense.app.ui.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.RoundIcon
import dev.shuttersense.app.ui.components.pressScale

// After the welcome: try the demo (a camera simulated on this phone) or
// connect a real one. The last choice is remembered.

@Composable
fun ChooseScreen(vm: AppViewModel) {
    Box(Modifier.fillMaxSize().background(Palette.Ink).windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Shutter Sense", style = MaterialTheme.typography.titleMedium, color = Palette.Text, modifier = Modifier.weight(1f))
                RoundIcon(Icons.AutoMirrored.Rounded.HelpOutline, "How it works", { vm.openWelcome() }, tint = Palette.Muted)
            }
            Spacer(Modifier.height(40.dp))
            Text("How do you want to start?", style = MaterialTheme.typography.displaySmall, color = Palette.Text)
            Spacer(Modifier.height(12.dp))
            Text(
                "Try it on a camera simulated on this phone, or connect your own.",
                style = MaterialTheme.typography.bodyLarge,
                color = Palette.Muted,
            )
            Spacer(Modifier.height(36.dp))
            Choice(
                icon = Icons.Rounded.AutoAwesome,
                title = "Try the demo",
                body = "A camera simulated on this phone, with real-world scenes to fix. No camera needed.",
                highlight = true,
                last = vm.lastChoice == "demo",
                loading = vm.demoStarting,
                onClick = { vm.startDemo() },
            )
            Spacer(Modifier.height(12.dp))
            Choice(
                icon = Icons.Rounded.Wifi,
                title = "Connect my camera",
                body = "Over Wi-Fi. Works with cameras that support CCAPI.",
                highlight = false,
                last = vm.lastChoice == "camera",
                loading = false,
                onClick = { vm.chooseCamera() },
            )
            Spacer(Modifier.height(28.dp))
            Text(
                "You can switch any time from the menu.",
                Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall,
                color = Palette.Faint,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun Choice(icon: ImageVector, title: String, body: String, highlight: Boolean, last: Boolean, loading: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val bg = if (highlight) Brush.linearGradient(listOf(Color(0xFF2A1E0A), Palette.Raised)) else Brush.linearGradient(listOf(Palette.Raised, Palette.Raised))
    Column(
        Modifier
            .fillMaxWidth()
            .pressScale(source)
            .clip(RoundedCornerShape(26.dp))
            .background(bg)
            .clickable(source, null, enabled = !loading, onClick = onClick)
            .padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(48.dp).clip(CircleShape).background(if (highlight) Palette.Accent else Palette.Raised2),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, null, Modifier.size(24.dp), tint = if (highlight) Palette.AccentInk else Palette.Text)
            }
            Spacer(Modifier.weight(1f))
            if (last && !loading) Eyebrow("Last used", color = Palette.Muted)
            Spacer(Modifier.width(12.dp))
            if (loading) CircularProgressIndicator(Modifier.size(22.dp), color = Palette.Accent, strokeWidth = 2.dp)
            else Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, Modifier.size(22.dp), tint = if (highlight) Palette.Accent else Palette.Muted)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(if (loading) "Starting the demo camera…" else title, style = MaterialTheme.typography.headlineSmall, color = Palette.Text)
            Text(body, style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
        }
    }
}
