package app.murmur.android.overlay

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

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

    companion object {
        val EMPTY = Box(0f, 0f, 0f, 0f)

        fun centered(cx: Float, cy: Float, w: Float, h: Float): Box =
            Box(cx - w / 2f, cy - h / 2f, cx + w / 2f, cy + h / 2f)
    }
}

/**
 * Result of pulling a dragged point onto nearby alignment guides. [guideX] is the x of the
 * vertical guide the point snapped to (null when it did not), [guideY] the y of the horizontal one.
 */
data class GuideSnap(val x: Float, val y: Float, val guideX: Float?, val guideY: Float?)

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

    /** Dragging within this distance of a guide (the middle of the screen, another spot's row or column) snaps to it. */
    const val SNAP_DP = 14f

    /** How far ahead a released drag "looks" along its velocity when choosing the spot to land on. */
    const val FLING_LOOKAHEAD_S = 0.12f

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
            xFraction = if (screenW > 0f) (cx / screenW).coerceIn(0f, 1f) else OverlayAnchor.DEFAULT_X,
            offsetDp = (referenceY(screenH, keyboardTop, density) - cy) / density
        )

    /**
     * Pull a dragged centre onto the nearest guide on each axis, if one is within [SNAP_DP].
     * [guidesX] are x positions of vertical guides (the middle of the screen, other spots'
     * columns), [guidesY] y positions of horizontal ones (other spots' rows).
     */
    fun snapToGuides(cx: Float, cy: Float, guidesX: List<Float>, guidesY: List<Float>, density: Float): GuideSnap {
        val reach = SNAP_DP * density
        val gx = guidesX.minByOrNull { abs(it - cx) }?.takeIf { abs(it - cx) <= reach }
        val gy = guidesY.minByOrNull { abs(it - cy) }?.takeIf { abs(it - cy) <= reach }
        return GuideSnap(gx ?: cx, gy ?: cy, gx, gy)
    }

    /**
     * The spot (index into [spots], screen-space centres) a drag released at (cx, cy) should land
     * on: the one nearest to where the finger was heading. A flick therefore reaches a spot the
     * finger did not travel all the way to. [vx]/[vy] are in px per second; the look-ahead is
     * capped at [maxLookaheadPx] so a violent fling does not sail past the intended spot.
     */
    fun nearestSpot(
        spots: List<Pair<Float, Float>>,
        cx: Float,
        cy: Float,
        vx: Float = 0f,
        vy: Float = 0f,
        maxLookaheadPx: Float = Float.MAX_VALUE
    ): Int {
        var dx = vx * FLING_LOOKAHEAD_S
        var dy = vy * FLING_LOOKAHEAD_S
        val len = hypot(dx, dy)
        if (len > maxLookaheadPx && len > 0f) {
            dx *= maxLookaheadPx / len
            dy *= maxLookaheadPx / len
        }
        val px = cx + dx
        val py = cy + dy
        var best = 0
        var bestDistance = Float.MAX_VALUE
        for ((i, spot) in spots.withIndex()) {
            val d = hypot(spot.first - px, spot.second - py)
            if (d < bestDistance) {
                bestDistance = d
                best = i
            }
        }
        return best
    }

    /** Centre coordinate for a segment of [size] inside [0, total] with [margin] on both sides. */
    fun clampCenter(center: Float, size: Float, total: Float, margin: Float): Float {
        val lo = margin + size / 2f
        val hi = total - margin - size / 2f
        return if (hi < lo) total / 2f else center.coerceIn(lo, hi)
    }
}

/**
 * A damped spring that carries a value (and whatever velocity a drag left it with) to a target:
 * the button lands on its spot quickly with a hint of overshoot instead of a canned ease.
 * Integrated in small fixed sub-steps so the motion is the same at any frame rate.
 */
class Spring(
    position: Float,
    velocity: Float = 0f,
    private val stiffness: Float = 560f,
    private val dampingRatio: Float = 0.8f
) {
    var position: Float = position
        private set
    var velocity: Float = velocity
        private set
    var target: Float = position

    /** Within half a pixel and nearly still: snapped exactly onto the target. */
    val settled: Boolean get() = position == target && velocity == 0f

    fun advance(dtMs: Long) {
        if (settled) return
        var remaining = dtMs.coerceIn(0L, 250L) / 1000f
        val omega = sqrt(stiffness)
        val damping = 2f * dampingRatio * omega
        while (remaining > 0f) {
            val h = min(remaining, STEP_S)
            val acceleration = -stiffness * (position - target) - damping * velocity
            velocity += acceleration * h
            position += velocity * h
            remaining -= h
        }
        if (abs(position - target) < 0.5f && abs(velocity) < 8f) {
            position = target
            velocity = 0f
        }
    }

    private companion object {
        const val STEP_S = 1f / 240f
    }
}

/**
 * Velocity of a finger from screen-space samples over its last 100 ms. Works from whatever
 * coordinates the caller feeds it, so it is unaffected by the overlay window moving and growing
 * underneath a drag (which would make the framework's view-relative tracker jump).
 */
class FlingTracker {
    private val times = LongArray(CAPACITY)
    private val xs = FloatArray(CAPACITY)
    private val ys = FloatArray(CAPACITY)
    private var count = 0
    private var next = 0

    fun reset() {
        count = 0
        next = 0
    }

    fun add(timeMs: Long, x: Float, y: Float) {
        times[next] = timeMs
        xs[next] = x
        ys[next] = y
        next = (next + 1) % CAPACITY
        if (count < CAPACITY) count++
    }

    /** (vx, vy) in px per second; zero when the finger rested before letting go. */
    fun velocity(): Pair<Float, Float> {
        if (count < 2) return 0f to 0f
        val newest = (next - 1 + CAPACITY) % CAPACITY
        val newestTime = times[newest]
        var oldest = newest
        for (k in 1 until count) {
            val i = (newest - k + CAPACITY) % CAPACITY
            if (newestTime - times[i] > WINDOW_MS) break
            oldest = i
        }
        val dt = newestTime - times[oldest]
        if (oldest == newest || dt <= 0L) return 0f to 0f
        val perSecond = 1000f / dt
        return (xs[newest] - xs[oldest]) * perSecond to (ys[newest] - ys[oldest]) * perSecond
    }

    private companion object {
        const val CAPACITY = 12
        const val WINDOW_MS = 100L
    }
}
