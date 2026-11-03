package dev.shuttersense.app.ui.setup

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.ui.AppViewModel
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.components.Eyebrow
import dev.shuttersense.app.ui.components.Sheet

// Demo mode's scene switcher: a compact chip (thumbnail and title) that opens
// a sheet of the simulator's scenes.

/** The current demo scene; tap to pick another. Nothing outside demo mode. */
@Composable
fun SceneChip(vm: AppViewModel, modifier: Modifier = Modifier, dark: Boolean = false) {
    if (!vm.demo || vm.scenes.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    val scene = vm.scenes.firstOrNull { it.id == vm.sceneId }
    Row(
        modifier
            .clip(CircleShape)
            .background(if (dark) Color(0x99000000) else Palette.Surface)
            .clickable(enabled = !vm.busy) { open = true }
            .padding(start = 4.dp, end = 10.dp, top = 4.dp, bottom = 4.dp)
            .alpha(if (vm.busy) 0.5f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(vm.sceneThumbs[vm.sceneId], 24.dp)
        Spacer(Modifier.width(8.dp))
        Text(
            scene?.title ?: "Scene",
            Modifier.widthIn(max = 150.dp),
            style = MaterialTheme.typography.labelMedium,
            color = Palette.Text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (vm.switchingScene) {
            Spacer(Modifier.width(6.dp))
            CircularProgressIndicator(Modifier.size(12.dp), color = Palette.Muted, strokeWidth = 1.5.dp)
        } else Icon(Icons.Rounded.ExpandMore, null, Modifier.size(16.dp), tint = Palette.Muted)
    }
    if (open) SceneSheet(vm) { open = false }
}

@Composable
private fun Thumb(image: ImageBitmap?, size: Dp, corner: Dp = size / 2) {
    Box(Modifier.size(size).clip(RoundedCornerShape(corner)).background(Palette.Raised2)) {
        if (image != null) Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}

@Composable
private fun SceneSheet(vm: AppViewModel, onDismiss: () -> Unit) {
    Sheet(onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 28.dp)) {
            Eyebrow("Demo camera")
            Spacer(Modifier.height(6.dp))
            Text("Pick a scene", style = MaterialTheme.typography.headlineSmall, color = Palette.Text)
            Spacer(Modifier.height(4.dp))
            Text("The simulated camera points at it, with settings that need fixing.", style = MaterialTheme.typography.bodyMedium, color = Palette.Muted)
            Spacer(Modifier.height(16.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                vm.scenes.forEach { sc ->
                    val on = sc.id == vm.sceneId
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp))
                            .background(if (on) Palette.Raised else Color.Transparent)
                            .clickable {
                                vm.selectScene(sc.id)
                                onDismiss()
                            }
                            .padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier.clip(RoundedCornerShape(12.dp))
                                .border(if (on) 2.dp else 0.dp, if (on) Palette.Accent else Color.Transparent, RoundedCornerShape(12.dp)),
                        ) { ThumbWide(vm.sceneThumbs[sc.id]) }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(sc.title, style = MaterialTheme.typography.titleMedium, color = Palette.Text)
                            Text(sc.blurb, style = MaterialTheme.typography.bodySmall, color = Palette.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (on) {
                            Spacer(Modifier.width(8.dp))
                            Icon(Icons.Rounded.Check, null, Modifier.size(20.dp), tint = Palette.Accent)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ThumbWide(image: ImageBitmap?) {
    Box(Modifier.width(84.dp).height(56.dp).background(Palette.Raised2)) {
        if (image != null) Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    }
}
