package dev.secondshooter.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Amber = Color(0xFFFFB547)
private val AmberDeep = Color(0xFF8A5300)

private val Dark = darkColorScheme(
    primary = Amber,
    onPrimary = Color(0xFF2B1A00),
    primaryContainer = Color(0xFF4A3000),
    onPrimaryContainer = Color(0xFFFFDDB3),
    secondary = Color(0xFF8FD3FF),
    background = Color(0xFF0F1114),
    surface = Color(0xFF15181C),
    surfaceVariant = Color(0xFF22262C),
    surfaceContainer = Color(0xFF1B1F24),
    surfaceContainerHigh = Color(0xFF22262C),
    onSurfaceVariant = Color(0xFFB7BEC7),
    error = Color(0xFFFF8A80),
)

private val Light = lightColorScheme(
    primary = AmberDeep,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDDB3),
    onPrimaryContainer = Color(0xFF2B1A00),
    secondary = Color(0xFF00658E),
    background = Color(0xFFF8F6F3),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFF0ECE6),
    surfaceContainer = Color(0xFFF4F1EC),
    surfaceContainerHigh = Color(0xFFEDE8E1),
)

@Composable
fun SecondShooterTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
