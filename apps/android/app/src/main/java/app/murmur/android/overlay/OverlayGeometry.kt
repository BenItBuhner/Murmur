package app.murmur.android.overlay

import app.murmur.android.settings.DEFAULT_OVERLAY_ANCHOR_X
import app.murmur.android.settings.DEFAULT_OVERLAY_OFFSET_DP
import app.murmur.android.settings.MurmurSettings
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Axis-aligned rectangle in pixels. Plain Kotlin (no android.graphics) so the overlay maths is unit-testable. */
data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val centerX: Float get() = (left + right) / 2f
    val centerY: Float get() = (top + bottom) / 2f

    fun contains(x: Float, y: Float): Boolean = x >= left && x <= right && y >= top && y <= bottom

    fun union(other: Box): Box =
        Box(min(left, other.left), min(top, other.top), max(right, other.right), max(bottom, other.bottom))

    fun inflate(d: Float): Box = Box(left - d, top - d, right + d, bottom + d)

    fun offset(dx: Float, dy: Float): Box = Box(left + dx, top + dy, right + dx, bottom + dy)

    /** The part of this box that lies inside [bounds]. */
    fun intersect(bounds: Box): Box {
        val l = left.coerceIn(bounds.left, bounds.right)
        val t = top.coerceIn(bounds.top, bounds.bottom)
        return Box(l, t, right.coerceIn(l, bounds.right), bottom.coerceIn(t, bounds.bottom))
    }

    fun approximately(other: Box, epsilon: Float = 0.5f): Boolean =
        abs(left - other.left) < epsilon && abs(top - other.top) < epsilon &&
            abs(right - other.right) < epsilon && abs(bottom - other.bottom) < epsilon

    /** True when [other] lies within this box (allowing [epsilon] of slack on every edge). */
    fun encloses(other: Box, epsilon: Float = 0.5f): Boolean =
        other.left >= left - epsilon && other.top >= top - epsilon &&
            other.right <= right + epsilon && other.bottom <= bottom + epsilon

    companion object {
        val EMPTY = Box(0f, 0f, 0f, 0f)

        fun centered(cx: Float, cy: Float, w: Float, h: Float): Box =
            Box(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f)
    }
}

/**
 * Where the user parked the dictation button, independent of screen size and keyboard height:
 * the button's centre sits at [xFraction] of the screen width and [offsetDp] dp above the top edge
 * of the keyboard. A negative offset puts it over the keyboard, e.g. on its toolbar row.
 */
data class OverlayAnchor(val xFraction: Float, val offsetDp: Float) {
    /** Rounded for storage (a tenth of a pixel on a 1080 px wide screen) so a drag does not persist float noise. */
    fun rounded(): OverlayAnchor =
        OverlayAnchor(Math.round(xFraction * 10_000f) / 10_000f, Math.round(offsetDp * 100f) / 100f)

    companion object {
        val DEFAULT = OverlayAnchor(DEFAULT_OVERLAY_ANCHOR_X, DEFAULT_OVERLAY_OFFSET_DP)
    }
}

fun MurmurSettings.overlayAnchor(): OverlayAnchor = OverlayAnchor(overlayAnchorX, overlayOffsetDp)

/**
 * Screen-space layout of the floating pill. Everything is expressed around a single anchor point
 * (the centre of the resting button) so that every state of the pill grows out of the same spot,
 * sliding inwards only as far as needed to stay on the screen.
 */
object OverlayGeometry {
    /** Distance kept between the pill and the screen edges. */
    const val EDGE_MARGIN_DP = 6f

    /** Resting line for the vertical offset when no keyboard is on screen. */
    const val NO_KEYBOARD_BASELINE_DP = 96f

    /** Dragging within this distance of the horizontal centre snaps to it. */
    const val SNAP_DP = 14f

    /** The line the vertical offset is measured from: the keyboard's top edge, or a resting line without one. */
    fun referenceY(screenH: Float, keyboardTop: Float?, density: Float): Float =
        keyboardTop?.takeIf { it > 0f } ?: (screenH - NO_KEYBOARD_BASELINE_DP * density)

    /**
     * Screen-space centre of a [w] x [h] button for [anchor], nudged so the whole button stays on
     * screen. Returns (x, y).
     */
    fun anchorPoint(
        anchor: OverlayAnchor,
        screenW: Float,
        screenH: Float,
        keyboardTop: Float?,
        density: Float,
        w: Float,
        h: Float
    ): Pair<Float, Float> {
        val margin = EDGE_MARGIN_DP * density
        val x = clampCenter(anchor.xFraction * screenW, w, screenW, margin)
        val y = clampCenter(referenceY(screenH, keyboardTop, density) - anchor.offsetDp * density, h, screenH, margin)
        return x to y
    }

    /** Centre a [w] x [h] pill on (cx, cy), sliding it inwards so it stays on screen. */
    fun place(cx: Float, cy: Float, w: Float, h: Float, screenW: Float, screenH: Float, density: Float): Box {
        val margin = EDGE_MARGIN_DP * density
        val x = clampCenter(cx, w, screenW, margin)
        val y = clampCenter(cy, h, screenH, margin)
        return Box.centered(x, y, w, h)
    }

    /** Inverse of [anchorPoint]: the anchor that puts the button's centre at (cx, cy). */
    fun anchorFor(cx: Float, cy: Float, screenW: Float, screenH: Float, keyboardTop: Float?, density: Float): OverlayAnchor =
        OverlayAnchor(
            xFraction = if (screenW > 0f) (cx / screenW).coerceIn(0f, 1f) else DEFAULT_OVERLAY_ANCHOR_X,
            offsetDp = (referenceY(screenH, keyboardTop, density) - cy) / density
        )

    /** Magnetic centre while dragging. */
    fun snapX(cx: Float, screenW: Float, density: Float): Float {
        val mid = screenW / 2f
        return if (abs(cx - mid) <= SNAP_DP * density) mid else cx
    }

    /** Centre coordinate for a segment of [size] inside [0, total] with [margin] on both sides. */
    fun clampCenter(center: Float, size: Float, total: Float, margin: Float): Float {
        val lo = margin + size / 2f
        val hi = total - margin - size / 2f
        return if (hi < lo) total / 2f else center.coerceIn(lo, hi)
    }
}
