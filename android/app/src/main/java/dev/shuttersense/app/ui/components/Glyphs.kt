package dev.shuttersense.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Line glyphs the icon set lacks.

/** A pair of display glasses, drawn to sit with the rounded Material icons. */
@Composable
fun GlassesGlyph(color: Color, modifier: Modifier = Modifier, size: Dp = 22.dp) {
    Canvas(modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val stroke = w * 0.085f
        val lensW = w * 0.36f
        val lensH = h * 0.30f
        val top = h * 0.38f
        val r = CornerRadius(lensH * 0.45f)
        val style = Stroke(stroke, cap = StrokeCap.Round)
        drawRoundRect(color, Offset(w * 0.08f, top), Size(lensW, lensH), r, style = style)
        drawRoundRect(color, Offset(w * 0.92f - lensW, top), Size(lensW, lensH), r, style = style)
        // Bridge and the temples.
        val bridge = Path().apply {
            moveTo(w * 0.08f + lensW, top + lensH * 0.35f)
            quadraticTo(w * 0.5f, top + lensH * 0.05f, w * 0.92f - lensW, top + lensH * 0.35f)
        }
        drawPath(bridge, color, style = style)
        drawLine(color, Offset(w * 0.08f, top + lensH * 0.2f), Offset(w * 0.02f, top - lensH * 0.15f), stroke, StrokeCap.Round)
        drawLine(color, Offset(w * 0.92f, top + lensH * 0.2f), Offset(w * 0.98f, top - lensH * 0.15f), stroke, StrokeCap.Round)
    }
}
