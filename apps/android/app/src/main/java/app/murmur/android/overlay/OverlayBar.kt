package app.murmur.android.overlay

import app.murmur.android.settings.OverlayPosition
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Size and placement of the desktop-style idle bar (tablet, hardware keyboard, DeX). The phone's
 * floating button does not use this: it still rests on its spots.
 *
 * [BarAnchor.PRESET] is the three positions the bar has always had, so an install that has never
 * moved it stays centered at the bottom at the current size. [BarAnchor.FREE] is a center the user
 * dragged to, as fractions of the screen, so the bar is not stuck on one spot.
 */
enum class BarAnchor { PRESET, FREE }

data class OverlayBar(
    val anchor: BarAnchor = BarAnchor.PRESET,
    /** Center of the idle bar as fractions of the screen. Ignored while [anchor] is [BarAnchor.PRESET]. */
    val x: Float = 0.5f,
    val y: Float = 0.5f,
    val widthDp: Float = DEFAULT_WIDTH_DP,
    val heightDp: Float = DEFAULT_HEIGHT_DP
) {
    fun clamped(): OverlayBar = copy(
        x = x.coerceIn(0f, 1f),
        y = y.coerceIn(0f, 1f),
        widthDp = widthDp.coerceIn(MIN_WIDTH_DP, MAX_WIDTH_DP),
        heightDp = heightDp.coerceIn(MIN_HEIGHT_DP, MAX_HEIGHT_DP)
    )

    /** Rounded for storage so a drag does not persist float noise. */
    fun rounded(): OverlayBar {
        val bar = clamped()
        return bar.copy(
            x = (bar.x * 10_000f).roundToInt() / 10_000f,
            y = (bar.y * 10_000f).roundToInt() / 10_000f,
            widthDp = (bar.widthDp * 10f).roundToInt() / 10f,
            heightDp = (bar.heightDp * 10f).roundToInt() / 10f
        )
    }

    companion object {
        const val DEFAULT_WIDTH_DP = 56f
        const val DEFAULT_HEIGHT_DP = 6f
        const val MIN_WIDTH_DP = 24f
        const val MAX_WIDTH_DP = 280f
        const val MIN_HEIGHT_DP = 2f
        const val MAX_HEIGHT_DP = 32f
        /** A release within this many dp of a preset lands on that preset. Same reach as the desktop. */
        const val SNAP_DP = 24f
        val DEFAULT = OverlayBar()
    }
}

/** Which part of the idle bar a pointer is on. The bar itself moves; the ring around it resizes. */
enum class BarEdge { N, S, E, W, NE, NW, SE, SW, BODY }

object OverlayBarPlacement {
    /**
     * [local] coordinates are relative to the bar's top-left, so the padding ring is outside it.
     * Null when the pointer is outside the padding too.
     */
    fun edgeAt(bar: Box, x: Float, y: Float, pad: Float): BarEdge? {
        if (x < bar.left - pad || y < bar.top - pad || x > bar.right + pad || y > bar.bottom + pad) return null
        val outsideL = x < bar.left
        val outsideR = x > bar.right
        val outsideT = y < bar.top
        val outsideB = y > bar.bottom
        if (!outsideL && !outsideR && !outsideT && !outsideB) return BarEdge.BODY
        return when {
            outsideT && outsideL -> BarEdge.NW
            outsideT && outsideR -> BarEdge.NE
            outsideB && outsideL -> BarEdge.SW
            outsideB && outsideR -> BarEdge.SE
            outsideT -> BarEdge.N
            outsideB -> BarEdge.S
            outsideL -> BarEdge.W
            else -> BarEdge.E
        }
    }

    /** New size, in dp, after dragging [edge] by [dxDp] and [dyDp]. */
    fun resize(edge: BarEdge, widthDp: Float, heightDp: Float, dxDp: Float, dyDp: Float): OverlayBarSize {
        var width = widthDp
        var height = heightDp
        when (edge) {
            BarEdge.E, BarEdge.NE, BarEdge.SE -> width += dxDp
            BarEdge.W, BarEdge.NW, BarEdge.SW -> width -= dxDp
            else -> Unit
        }
        when (edge) {
            BarEdge.S, BarEdge.SE, BarEdge.SW -> height += dyDp
            BarEdge.N, BarEdge.NE, BarEdge.NW -> height -= dyDp
            else -> Unit
        }
        return OverlayBarSize(
            width.coerceIn(OverlayBar.MIN_WIDTH_DP, OverlayBar.MAX_WIDTH_DP),
            height.coerceIn(OverlayBar.MIN_HEIGHT_DP, OverlayBar.MAX_HEIGHT_DP)
        )
    }

    /**
     * Vertical center of a look of height [lookH] that keeps the idle bar's edge. A bar in the top
     * third grows downward (the way the top-center preset does); anywhere else it grows upward,
     * which is how the bottom bar has always grown.
     */
    fun lookCenterY(idleCenterY: Float, idleH: Float, lookH: Float, screenH: Float): Float {
        val growDown = idleCenterY < screenH * 0.35f
        return if (growDown) idleCenterY - idleH / 2f + lookH / 2f else idleCenterY + idleH / 2f - lookH / 2f
    }

    /** The preset whose center is within [snapPx], or null when the point has left all of them. */
    fun nearestPreset(
        x: Float,
        y: Float,
        presets: List<Pair<OverlayPosition, Pair<Float, Float>>>,
        snapPx: Float
    ): OverlayPosition? {
        var best: OverlayPosition? = null
        var bestDistance = snapPx
        for ((position, point) in presets) {
            val distance = hypot(point.first - x, point.second - y)
            if (distance <= bestDistance) {
                bestDistance = distance
                best = position
            }
        }
        return best
    }
}

data class OverlayBarSize(val widthDp: Float, val heightDp: Float)
