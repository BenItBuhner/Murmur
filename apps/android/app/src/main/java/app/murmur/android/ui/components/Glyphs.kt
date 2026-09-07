package app.murmur.android.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The icons the drawer and the dashboard need, drawn on a unit grid with one stroke weight so they
 * share a voice with the chevrons and arrows in Components.kt.
 */
enum class Glyph {
    MENU, HOME, HISTORY, DICTIONARY, STYLE, BUTTON, MODEL, LANGUAGE, APPEARANCE, PERMISSIONS, UPDATES,
    TRY_IT, ACCOUNT, WORDS, PACE, TIME, STREAK, SEARCH
}

@Composable
fun GlyphIcon(glyph: Glyph, color: Color, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    Canvas(modifier.size(size)) { draw(glyph, color) }
}

private fun DrawScope.p(x: Float, y: Float) = Offset(size.width * x, size.height * y)

private fun DrawScope.stroke() = Stroke(1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)

private fun DrawScope.line(color: Color, x1: Float, y1: Float, x2: Float, y2: Float) =
    drawLine(color, p(x1, y1), p(x2, y2), 1.6.dp.toPx(), StrokeCap.Round)

private fun DrawScope.path(color: Color, build: Path.(w: Float, h: Float) -> Unit) {
    val path = Path().apply { build(size.width, size.height) }
    drawPath(path, color, style = stroke())
}

private fun DrawScope.ring(color: Color, cx: Float, cy: Float, r: Float) =
    drawCircle(color, size.width * r, p(cx, cy), style = stroke())

fun DrawScope.draw(glyph: Glyph, color: Color) {
    when (glyph) {
        Glyph.MENU -> {
            line(color, 0.2f, 0.3f, 0.8f, 0.3f)
            line(color, 0.2f, 0.5f, 0.8f, 0.5f)
            line(color, 0.2f, 0.7f, 0.8f, 0.7f)
        }
        Glyph.HOME -> {
            path(color) { w, h ->
                moveTo(w * 0.18f, h * 0.5f); lineTo(w * 0.5f, h * 0.2f); lineTo(w * 0.82f, h * 0.5f)
            }
            path(color) { w, h ->
                moveTo(w * 0.27f, h * 0.45f); lineTo(w * 0.27f, h * 0.8f); lineTo(w * 0.73f, h * 0.8f); lineTo(w * 0.73f, h * 0.45f)
            }
            path(color) { w, h ->
                moveTo(w * 0.43f, h * 0.8f); lineTo(w * 0.43f, h * 0.6f); lineTo(w * 0.57f, h * 0.6f); lineTo(w * 0.57f, h * 0.8f)
            }
        }
        Glyph.HISTORY, Glyph.TIME -> {
            ring(color, 0.5f, 0.5f, 0.3f)
            line(color, 0.5f, 0.5f, 0.5f, 0.32f)
            line(color, 0.5f, 0.5f, 0.64f, 0.58f)
        }
        Glyph.DICTIONARY -> {
            path(color) { w, h ->
                moveTo(w * 0.2f, h * 0.24f); lineTo(w * 0.5f, h * 0.31f); lineTo(w * 0.8f, h * 0.24f)
                lineTo(w * 0.8f, h * 0.74f); lineTo(w * 0.5f, h * 0.81f); lineTo(w * 0.2f, h * 0.74f); close()
            }
            line(color, 0.5f, 0.31f, 0.5f, 0.81f)
        }
        Glyph.STYLE -> {
            path(color) { w, h ->
                moveTo(w * 0.46f, h * 0.2f)
                quadraticTo(w * 0.48f, h * 0.5f, w * 0.78f, h * 0.54f)
                quadraticTo(w * 0.48f, h * 0.58f, w * 0.46f, h * 0.86f)
                quadraticTo(w * 0.44f, h * 0.58f, w * 0.16f, h * 0.54f)
                quadraticTo(w * 0.44f, h * 0.5f, w * 0.46f, h * 0.2f)
                close()
            }
            drawCircle(color, size.width * 0.04f, p(0.8f, 0.24f))
        }
        Glyph.BUTTON -> {
            val r = size.height * 0.14f
            drawRoundRect(
                color,
                topLeft = p(0.14f, 0.36f),
                size = Size(size.width * 0.72f, size.height * 0.28f),
                cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
                style = stroke()
            )
            drawCircle(color, size.width * 0.05f, p(0.5f, 0.5f))
        }
        Glyph.MODEL -> {
            line(color, 0.18f, 0.42f, 0.18f, 0.58f)
            line(color, 0.34f, 0.32f, 0.34f, 0.68f)
            line(color, 0.5f, 0.2f, 0.5f, 0.8f)
            line(color, 0.66f, 0.32f, 0.66f, 0.68f)
            line(color, 0.82f, 0.42f, 0.82f, 0.58f)
        }
        Glyph.LANGUAGE -> {
            ring(color, 0.5f, 0.5f, 0.3f)
            drawOval(color, topLeft = p(0.37f, 0.2f), size = Size(size.width * 0.26f, size.height * 0.6f), style = stroke())
            line(color, 0.2f, 0.5f, 0.8f, 0.5f)
        }
        Glyph.APPEARANCE -> {
            ring(color, 0.5f, 0.5f, 0.3f)
            drawArc(
                color, startAngle = -90f, sweepAngle = 180f, useCenter = true,
                topLeft = p(0.2f, 0.2f), size = Size(size.width * 0.6f, size.height * 0.6f)
            )
        }
        Glyph.PERMISSIONS -> {
            path(color) { w, h ->
                moveTo(w * 0.5f, h * 0.18f); lineTo(w * 0.78f, h * 0.29f); lineTo(w * 0.78f, h * 0.5f)
                quadraticTo(w * 0.78f, h * 0.7f, w * 0.5f, h * 0.83f)
                quadraticTo(w * 0.22f, h * 0.7f, w * 0.22f, h * 0.5f)
                lineTo(w * 0.22f, h * 0.29f); close()
            }
            path(color) { w, h ->
                moveTo(w * 0.39f, h * 0.51f); lineTo(w * 0.47f, h * 0.59f); lineTo(w * 0.62f, h * 0.42f)
            }
        }
        Glyph.UPDATES -> {
            line(color, 0.5f, 0.2f, 0.5f, 0.6f)
            path(color) { w, h -> moveTo(w * 0.36f, h * 0.47f); lineTo(w * 0.5f, h * 0.61f); lineTo(w * 0.64f, h * 0.47f) }
            path(color) { w, h ->
                moveTo(w * 0.22f, h * 0.66f); lineTo(w * 0.22f, h * 0.8f); lineTo(w * 0.78f, h * 0.8f); lineTo(w * 0.78f, h * 0.66f)
            }
        }
        Glyph.TRY_IT -> {
            path(color) { w, h ->
                moveTo(w * 0.34f, h * 0.22f); lineTo(w * 0.78f, h * 0.5f); lineTo(w * 0.34f, h * 0.78f); close()
            }
        }
        Glyph.ACCOUNT -> {
            ring(color, 0.5f, 0.36f, 0.14f)
            path(color) { w, h ->
                moveTo(w * 0.22f, h * 0.82f)
                quadraticTo(w * 0.22f, h * 0.58f, w * 0.5f, h * 0.58f)
                quadraticTo(w * 0.78f, h * 0.58f, w * 0.78f, h * 0.82f)
            }
        }
        Glyph.WORDS -> {
            line(color, 0.2f, 0.3f, 0.8f, 0.3f)
            line(color, 0.2f, 0.5f, 0.68f, 0.5f)
            line(color, 0.2f, 0.7f, 0.5f, 0.7f)
        }
        Glyph.PACE -> {
            drawArc(
                color, startAngle = 180f, sweepAngle = 180f, useCenter = false,
                topLeft = p(0.2f, 0.32f), size = Size(size.width * 0.6f, size.height * 0.6f), style = stroke()
            )
            line(color, 0.5f, 0.62f, 0.66f, 0.42f)
            line(color, 0.2f, 0.72f, 0.8f, 0.72f)
        }
        Glyph.STREAK -> {
            path(color) { w, h ->
                moveTo(w * 0.5f, h * 0.18f)
                quadraticTo(w * 0.74f, h * 0.4f, w * 0.74f, h * 0.6f)
                quadraticTo(w * 0.74f, h * 0.82f, w * 0.5f, h * 0.84f)
                quadraticTo(w * 0.26f, h * 0.82f, w * 0.26f, h * 0.6f)
                quadraticTo(w * 0.26f, h * 0.48f, w * 0.38f, h * 0.38f)
                quadraticTo(w * 0.4f, h * 0.5f, w * 0.5f, h * 0.54f)
                quadraticTo(w * 0.6f, h * 0.42f, w * 0.5f, h * 0.18f)
                close()
            }
        }
        Glyph.SEARCH -> {
            ring(color, 0.44f, 0.44f, 0.22f)
            line(color, 0.6f, 0.6f, 0.78f, 0.78f)
        }
    }
}
