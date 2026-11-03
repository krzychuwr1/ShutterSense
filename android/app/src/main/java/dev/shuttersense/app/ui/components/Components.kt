package dev.shuttersense.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import dev.shuttersense.app.ui.Numeric
import dev.shuttersense.app.ui.Palette
import dev.shuttersense.app.ui.decodeDataUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

// Small building blocks shared by the screens: buttons, fields, the status
// dot, the notice toast and the full-screen photo viewer.

/** Shrinks a little while pressed. */
@Composable
fun Modifier.pressScale(source: MutableInteractionSource): Modifier {
    val pressed by source.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) 0.96f else 1f, spring(dampingRatio = 0.6f, stiffness = 800f), label = "press")
    return this.scale(s)
}

/** The one big call to action: an amber pill. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .height(56.dp)
            .pressScale(source)
            .clip(CircleShape)
            .background(if (enabled) Palette.Accent else Palette.Raised2)
            .clickable(source, null, enabled = enabled && !loading, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 24.dp)) {
            if (loading) {
                CircularProgressIndicator(Modifier.size(18.dp), color = Palette.AccentInk, strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
            } else if (icon != null) {
                Icon(icon, null, Modifier.size(20.dp), tint = if (enabled) Palette.AccentInk else Palette.Muted)
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge, color = if (enabled) Palette.AccentInk else Palette.Muted)
        }
    }
}

/** A quiet pill: raised surface, light text. */
@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, height: Dp = 48.dp, enabled: Boolean = true) {
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .height(height)
            .pressScale(source)
            .clip(CircleShape)
            .background(Palette.Raised)
            .clickable(source, null, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 18.dp).alpha(if (enabled) 1f else 0.4f)) {
            if (icon != null) {
                Icon(icon, null, Modifier.size(18.dp), tint = Palette.Text)
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge, color = Palette.Text)
        }
    }
}

/** Text only, for "Skip", "Advanced" and the like. */
@Composable
fun TextAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Palette.Muted, icon: ImageVector? = null) {
    Row(
        modifier.clip(CircleShape).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = color)
        if (icon != null) {
            Spacer(Modifier.width(4.dp))
            Icon(icon, null, Modifier.size(18.dp), tint = color)
        }
    }
}

/** A round icon button. */
@Composable
fun RoundIcon(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    container: Color = Color.Transparent,
    tint: Color = Palette.Text,
    enabled: Boolean = true,
    content: (@Composable BoxScope.() -> Unit)? = null,
) {
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .size(size)
            .pressScale(source)
            .clip(CircleShape)
            .background(container)
            .clickable(source, null, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (content != null) content() else Icon(icon, description, Modifier.size(size * 0.5f).alpha(if (enabled) 1f else 0.35f), tint = tint)
    }
}

/** Green when connected; [pulse] breathes while something is in progress. */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, pulse: Boolean = false, size: Dp = 8.dp) {
    val t = rememberInfiniteTransition(label = "dot")
    val a by t.animateFloat(1f, if (pulse) 0.25f else 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "dotAlpha")
    Box(modifier.size(size).alpha(a).clip(CircleShape).background(color))
}

/** A setting as "Label: value" (a preset's lines), the value brighter than its label. */
@Composable
fun SettingChip(line: String, modifier: Modifier = Modifier, container: Color = Palette.Surface) {
    val i = line.indexOf(": ")
    val text = buildAnnotatedString {
        if (i < 0) append(line) else {
            withStyle(SpanStyle(color = Palette.Muted)) { append(line.substring(0, i + 1)) }
            append(" ")
            append(line.substring(i + 2))
        }
    }
    Text(
        text,
        modifier.clip(RoundedCornerShape(10.dp)).background(container).padding(horizontal = 10.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelMedium.merge(Numeric),
        color = Palette.Text,
    )
}

/** Small uppercase label above a group. */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: Color = Palette.Muted) {
    Text(text.uppercase(), modifier, style = MaterialTheme.typography.labelSmall, color = color)
}

/** A borderless text field on a raised surface, with its label inside. */
@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    keyboardType: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
    onDone: (() -> Unit)? = null,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .background(Palette.Raised)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = Palette.Muted)
        Spacer(Modifier.height(2.dp))
        Box {
            if (value.isEmpty() && placeholder.isNotEmpty()) {
                Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = Palette.Faint)
            }
            BasicTextField(
                value, onValueChange,
                Modifier.fillMaxWidth(),
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = Palette.Text),
                cursorBrush = SolidColor(Palette.Accent),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = if (onDone != null) androidx.compose.ui.text.input.ImeAction.Go else androidx.compose.ui.text.input.ImeAction.Next),
                keyboardActions = KeyboardActions(onGo = { onDone?.invoke() }),
                visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
            )
        }
    }
}

/** A short message that slides in at the top and fades after a few seconds. */
@Composable
fun NoticeToast(notice: String?, onShown: () -> Unit, modifier: Modifier = Modifier) {
    var shown by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(notice) {
        if (notice != null) {
            shown = notice
            onShown()
        }
    }
    LaunchedEffect(shown) {
        if (shown != null) {
            delay(3200)
            shown = null
        }
    }
    Box(modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(
            shown != null,
            enter = fadeIn() + slideInVertically { -it },
            exit = fadeOut() + slideOutVertically { -it },
        ) {
            var last by remember { mutableStateOf("") }
            shown?.let { last = it }
            Text(
                last,
                Modifier
                    .padding(top = 12.dp, start = 24.dp, end = 24.dp)
                    .clip(CircleShape)
                    .background(Palette.Raised2)
                    .clickable { shown = null }
                    .padding(horizontal = 18.dp, vertical = 12.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = Palette.Text,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** A photo filling the screen: pinch to zoom, double-tap to reset, tap outside or back to close. */
@Composable
fun PhotoViewer(image: ImageBitmap, caption: String?, onDismiss: () -> Unit) {
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        val state = rememberTransformableState { zoom, pan, _ ->
            scale = (scale * zoom).coerceIn(1f, 6f)
            offset = if (scale == 1f) Offset.Zero else offset + pan
        }
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTapGestures(
                        onTap = { onDismiss() },
                        onDoubleTap = {
                            scale = 1f
                            offset = Offset.Zero
                        },
                    )
                },
        ) {
            Image(
                image, caption,
                Modifier
                    .fillMaxSize()
                    .transformable(state)
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
                contentScale = ContentScale.Fit,
            )
            if (caption != null) {
                Text(
                    caption,
                    Modifier
                        .align(Alignment.BottomCenter)
                        .windowInsetsPadding(WindowInsets.safeDrawing)
                        .padding(24.dp)
                        .clip(CircleShape)
                        .background(Color(0x99000000))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.Text,
                )
            }
            RoundIcon(
                Icons.Filled.Close, "Close", onDismiss,
                Modifier.align(Alignment.TopEnd).windowInsetsPadding(WindowInsets.safeDrawing).padding(12.dp),
                container = Color(0x66000000),
            )
        }
    }
}

/** A JPEG data URL, decoded off the main thread once per URL (null until ready). */
@Composable
fun rememberDataUrlImage(url: String?): ImageBitmap? {
    val state = produceState<ImageBitmap?>(null, url) {
        value = url?.let { withContext(Dispatchers.Default) { decodeDataUrl(it)?.asImageBitmap() } }
    }
    return state.value
}
