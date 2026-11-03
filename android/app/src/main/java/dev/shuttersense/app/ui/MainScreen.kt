package dev.shuttersense.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.shuttersense.app.ui.agent.AgentScreen
import dev.shuttersense.app.ui.camera.CameraScreen
import dev.shuttersense.app.ui.components.GlassesGlyph
import dev.shuttersense.app.ui.components.RoundIcon
import dev.shuttersense.app.ui.components.StatusDot
import dev.shuttersense.app.ui.settings.GlassesSheet
import dev.shuttersense.app.ui.settings.SettingsSheet

// The screens after connecting. Narrow (folded): Agent and Camera behind a
// segmented control. Wide (unfolded): camera on the left, chat on the right.

/** From this width up, the camera and the chat sit side by side. */
val WIDE = 680.dp

@Composable
fun MainScreen(vm: AppViewModel) {
    var menu by rememberSaveable { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize().background(Palette.Ink).windowInsetsPadding(WindowInsets.safeDrawing)) {
        val wide = maxWidth >= WIDE
        // Back leaves the demo or the camera for the chooser; during a run it first stops the run.
        BackHandler { if (vm.busy) vm.cancel() else vm.openChooser() }
        BackHandler(enabled = !wide && vm.tab == Tab.CAMERA) { vm.tab = Tab.AGENT }
        Column(Modifier.fillMaxSize()) {
            TopBar(vm, wide, onMenu = { menu = true })
            if (wide) {
                Row(Modifier.weight(1f).fillMaxWidth()) {
                    CameraScreen(vm, Modifier.weight(1.1f).fillMaxHeight().padding(top = 4.dp), showAgentLink = false)
                    Spacer(Modifier.width(8.dp))
                    // The scene switcher sits on the live view here.
                    AgentScreen(vm, Modifier.weight(1f).fillMaxHeight(), sceneChip = false)
                }
            } else {
                AnimatedContent(
                    vm.tab,
                    Modifier.weight(1f),
                    transitionSpec = { fadeIn(tween(220, 60)) togetherWith fadeOut(tween(120)) },
                    label = "tab",
                ) { t ->
                    when (t) {
                        Tab.AGENT -> AgentScreen(vm, Modifier.fillMaxSize())
                        Tab.CAMERA -> CameraScreen(vm, Modifier.fillMaxSize().padding(top = 8.dp))
                    }
                }
            }
        }
    }
    if (vm.showGlasses) GlassesSheet(vm)
    if (menu) SettingsSheet(vm) { menu = false }
}

@Composable
private fun TopBar(vm: AppViewModel, wide: Boolean, onMenu: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(60.dp).padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (wide) {
            Text("Shutter Sense", style = MaterialTheme.typography.titleMedium, color = Palette.Text)
            Spacer(Modifier.width(16.dp))
            val c = vm.camera as? CameraStatus.Connected
            if (c != null) Row(
                Modifier.widthIn(max = 420.dp).clip(CircleShape).background(Palette.Surface).clickable(onClick = onMenu).padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusDot(Palette.Good, size = 6.dp)
                Spacer(Modifier.width(8.dp))
                Text(if (vm.demo) c.model else listOfNotNull(c.model, c.lens).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = Palette.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        } else {
            Segmented(vm.tab) { vm.tab = it }
        }
        Spacer(Modifier.weight(1f))
        RoundIcon(Icons.Rounded.MoreHoriz, "Glasses", { vm.openGlasses() }) {
            GlassesGlyph(if (vm.glassesOnline > 0) Palette.Text else Palette.Muted, size = 24.dp)
            if (vm.glassesOnline > 0) StatusDot(Palette.Good, Modifier.align(Alignment.TopEnd).offset(x = (-9).dp, y = 11.dp), size = 7.dp)
        }
        RoundIcon(Icons.Rounded.MoreHoriz, "Menu", onMenu, tint = Palette.Muted)
    }
}

/** Agent | Camera, with a pill that slides under the chosen one. */
@Composable
private fun Segmented(tab: Tab, onChange: (Tab) -> Unit) {
    val itemW = 92.dp
    val x by animateDpAsState(if (tab == Tab.AGENT) 0.dp else itemW, spring(dampingRatio = 0.8f, stiffness = 500f), label = "seg")
    Box(Modifier.clip(CircleShape).background(Palette.Surface).padding(4.dp)) {
        Box(Modifier.offset(x = x).width(itemW).height(36.dp).clip(CircleShape).background(Palette.Raised2))
        Row {
            for (t in Tab.entries) {
                val on = t == tab
                Box(
                    Modifier.width(itemW).height(36.dp).clip(CircleShape).clickable { onChange(t) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (t == Tab.AGENT) "Agent" else "Camera",
                        style = MaterialTheme.typography.labelLarge,
                        color = if (on) Palette.Text else Palette.Muted,
                    )
                }
            }
        }
    }
}

/** Welcome, connect, or the main screens, with the notice toast over all of them. */
@Composable
fun AppRoot(vm: AppViewModel) {
    Box(Modifier.fillMaxSize().background(Palette.Ink)) {
        val screen = when {
            vm.showWelcome -> 0
            vm.inMain -> 3
            vm.setup == Setup.CHOOSE -> 1
            else -> 2
        }
        AnimatedContent(screen, transitionSpec = { fadeIn(tween(320, 80)) togetherWith fadeOut(tween(200)) }, label = "root") { s ->
            when (s) {
                0 -> dev.shuttersense.app.ui.welcome.WelcomeScreen(onDone = { vm.finishWelcome() }, canGoBack = vm.welcomeSeen)
                1 -> dev.shuttersense.app.ui.setup.ChooseScreen(vm)
                2 -> dev.shuttersense.app.ui.connect.ConnectScreen(vm)
                else -> MainScreen(vm)
            }
        }
        dev.shuttersense.app.ui.components.NoticeToast(vm.notice, onShown = { vm.notice = null })
    }
}
