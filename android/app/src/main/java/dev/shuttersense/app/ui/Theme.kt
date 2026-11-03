package dev.shuttersense.app.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Near-black surfaces, one amber accent (the web demo's), few borders. Dark
// only: the app is used next to a camera, often in dim places.

object Palette {
    val Ink = Color(0xFF09090B)
    val Surface = Color(0xFF111114)
    val Raised = Color(0xFF18181C)
    val Raised2 = Color(0xFF212126)
    val Line = Color(0xFF2A2A31)
    val Text = Color(0xFFF2F2F4)
    val Muted = Color(0xFF8E8E98)
    val Faint = Color(0xFF5A5A63)
    val Accent = Color(0xFFFFB547)
    val AccentInk = Color(0xFF1D1406)
    val AccentSoft = Color(0x1FFFB547)
    val Good = Color(0xFF5FD38D)
    val Bad = Color(0xFFFF7A72)
}

private val Colors = darkColorScheme(
    primary = Palette.Accent,
    onPrimary = Palette.AccentInk,
    primaryContainer = Color(0xFF3A2808),
    onPrimaryContainer = Color(0xFFFFDDB3),
    secondary = Palette.Accent,
    onSecondary = Palette.AccentInk,
    secondaryContainer = Palette.Raised2,
    onSecondaryContainer = Palette.Text,
    tertiary = Palette.Good,
    background = Palette.Ink,
    onBackground = Palette.Text,
    surface = Palette.Ink,
    onSurface = Palette.Text,
    surfaceVariant = Palette.Raised,
    onSurfaceVariant = Palette.Muted,
    surfaceContainerLowest = Palette.Ink,
    surfaceContainerLow = Palette.Surface,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.Raised,
    surfaceContainerHighest = Palette.Raised2,
    surfaceBright = Palette.Raised2,
    outline = Palette.Line,
    outlineVariant = Palette.Line,
    error = Palette.Bad,
    onError = Color(0xFF2B0A08),
    scrim = Color(0xCC000000),
)

private val Sans = FontFamily.SansSerif

private val Type = Typography(
    displaySmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 34.sp, lineHeight = 40.sp, letterSpacing = (-0.8).sp),
    headlineMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 34.sp, letterSpacing = (-0.6).sp),
    headlineSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.2.sp),
    labelSmall = TextStyle(fontFamily = Sans, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.8.sp),
)

private val Shape = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Tabular figures for exposure values, so digits don't jiggle as they change. */
val Numeric = TextStyle(fontFeatureSettings = "tnum")

@Composable
fun ShutterSenseTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Colors, typography = Type, shapes = Shape, content = content)
}
