package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.OverlayShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowLooper
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val KEYBOARD_TOP = 1500
private const val DENSITY = 3f
private const val FRAME_MS = 8L
private const val PILL_W = 64 * DENSITY
private const val PILL_H = 36 * DENSITY

/** config_mediumAnimTime, the duration of window_move_from_decor. */
private const val WINDOW_MOVE_MS = 400f

/**
 * What the screen shows of the pill, frame by frame, while it is picked up, dragged to the other
 * spot and let go: the canvas window's contents as drawn, placed where WindowManager actually has
 * the window's surface in that frame.
 *
 * Bennett's recording (frames 2025-2045 and 2295-2316) showed the pill drawn at the top of the
 * screen for a frame after landing and sliding back, and flying in from below the screen when
 * picked up. Both jumps are exactly the canvas window's change of origin: a window that is moved
 * and resized in one relayout is animated from its old position to the new one by WindowManager
 * (WindowState.handleWindowMovedIfNeeded, window_move_from_decor: decelerate_quint over
 * config_mediumAnimTime) while the view has already drawn for the new origin. [CompositorHost]
 * plays that part, so a canvas that changes origin during the gesture shows up as a pill off its
 * path.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillCompositionTest {

    private class CompositorHost : OverlayPillView.Host {
        val canvasFrames = ArrayList<Box>()
        var frame: Box? = null
            private set
        private var animFrom = 0f to 0f
        private var animElapsed = WINDOW_MOVE_MS

        override fun applyCanvasFrame(frame: Box) {
            canvasFrames += frame
            val old = this.frame
            val shown = if (old == null) null else shownOrigin()
            this.frame = frame
            val moved = old != null && (old.left != frame.left || old.top != frame.top)
            val resized = old != null && (old.width != frame.width || old.height != frame.height)
            if (shown != null && moved && resized) {
                animFrom = shown
                animElapsed = 0f
            }
        }

        override fun applyTouchFrame(frame: Box) = Unit

        /** Where the canvas surface is on screen in the frame being composed. */
        fun shownOrigin(): Pair<Float, Float> {
            val f = frame ?: return 0f to 0f
            if (animElapsed >= WINDOW_MOVE_MS) return f.left to f.top
            val t = animElapsed / WINDOW_MOVE_MS
            val v = 1f - (1f - t).pow(5)
            return (animFrom.first + (f.left - animFrom.first) * v) to (animFrom.second + (f.top - animFrom.second) * v)
        }

        fun tick() {
            animElapsed += FRAME_MS
        }
    }

    /** The recording's layout: the bottom-left corner over the keyboard and the middle just above it. */
    private val spots = OverlayLayout(listOf(OverlayAnchor(0.11f, -323f), OverlayAnchor(0.5f, 25f)), activeIndex = 0)

    private lateinit var view: OverlayPillView
    private lateinit var host: CompositorHost
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private val pixels = IntArray(SCREEN_W * SCREEN_H)
    private var downTime = 0L
    private val screen = Box(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat())

    @Before
    fun setUp() {
        host = CompositorHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply { host = this@OverlayPillCompositionTest.host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, spots)
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        repeat(60) { composedPill(); advance() }
    }

    private fun advance() {
        host.tick()
        ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
        ShadowLooper.idleMainLooper()
    }

    private fun spotCenter(index: Int): Pair<Float, Float> =
        OverlayGeometry.anchorPoint(spots.spots[index], SCREEN_W.toFloat(), SCREEN_H.toFloat(), KEYBOARD_TOP.toFloat(), DENSITY, PILL_W, PILL_H)

    private fun touch(action: Int, x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        if (action == MotionEvent.ACTION_DOWN) downTime = now
        val event = MotionEvent.obtain(downTime, now, action, x, y, 0)
        view.onScreenTouch(event, x, y)
        event.recycle()
    }

    /**
     * Draws the frame and returns the centre of the pill as the screen shows it: the opaque dark
     * body found in the canvas window's own pixels (only what fits the window is shown), offset by
     * where the window's surface is in this frame. Null when no part of the pill is on screen.
     */
    private fun composedPill(): Pair<Float, Float>? {
        bitmap.eraseColor(Color.TRANSPARENT)
        view.draw(canvas)
        val frame = host.frame ?: return null
        val w = min(SCREEN_W, frame.width.toInt())
        val h = min(SCREEN_H, frame.height.toInt())
        bitmap.getPixels(pixels, 0, SCREEN_W, 0, 0, SCREEN_W, SCREEN_H)
        val (ox, oy) = host.shownOrigin()
        var left = Int.MAX_VALUE
        var top = Int.MAX_VALUE
        var right = Int.MIN_VALUE
        var bottom = Int.MIN_VALUE
        for (y in 0 until h) {
            val sy = y + oy
            if (sy < 0f || sy >= SCREEN_H) continue
            val row = y * SCREEN_W
            for (x in 0 until w) {
                val sx = x + ox
                if (sx < 0f || sx >= SCREEN_W) continue
                val p = pixels[row + x]
                if (Color.alpha(p) < 230 || Color.red(p) > 0x30 || Color.green(p) > 0x30 || Color.blue(p) > 0x30) continue
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
            }
        }
        if (right < left) return null
        return (ox + (left + right + 1) / 2f) to (oy + (top + bottom + 1) / 2f)
    }

    private fun clampToScreen(x: Float, y: Float): Pair<Float, Float> {
        val margin = OverlayGeometry.EDGE_MARGIN_DP * DENSITY
        return OverlayGeometry.clampCenter(x, PILL_W, SCREEN_W.toFloat(), margin) to
            OverlayGeometry.clampCenter(y, PILL_H, SCREEN_H.toFloat(), margin)
    }

    /**
     * Picks the button up on spot [from], drags it in [steps] frames to just short of spot [to] and
     * lets go, then keeps composing frames until well after the landing. Every frame the screen
     * shows must have the pill on its path: under the finger while it is held, and between where it
     * was let go and the spot it lands on (with room for the spring's overshoot) afterwards.
     */
    private fun dragAndCheck(from: Int, to: Int, steps: Int) {
        val (x0, y0) = spotCenter(from)
        val (x1, y1) = spotCenter(to)
        val releaseX = x1 + (x0 - x1) * 0.08f
        val releaseY = y1 + (y0 - y1) * 0.08f
        val offPath = ArrayList<String>()

        val slop = ViewConfiguration.get(view.context).scaledTouchSlop.toFloat()
        var lifted = false
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        for (i in 1..steps) {
            val t = i.toFloat() / steps
            val fx = x0 + (releaseX - x0) * t
            val fy = y0 + (releaseY - y0) * t
            touch(MotionEvent.ACTION_MOVE, fx, fy)
            // Within the touch slop it is still a press on the spot; past it the finger holds the button.
            lifted = lifted || hypot(fx - x0, fy - y0) > slop
            val (ex, ey) = if (lifted) clampToScreen(fx, fy) else x0 to y0
            val shown = composedPill()
            if (shown == null || abs(shown.first - ex) > 4f || abs(shown.second - ey) > 4f) {
                offPath += "held frame $i: shown at $shown, finger holds it at ($ex, $ey)"
            }
            advance()
        }
        touch(MotionEvent.ACTION_UP, releaseX, releaseY)
        val (rx, ry) = clampToScreen(releaseX, releaseY)
        val reach = max(abs(x1 - rx), abs(y1 - ry)) * 0.15f + 12 * DENSITY
        val path = Box(min(rx, x1), min(ry, y1), max(rx, x1), max(ry, y1)).inflate(reach)
        repeat(120) { i ->
            val shown = composedPill()
            if (shown == null || !path.contains(shown.first, shown.second)) {
                offPath += "landing frame $i: shown at $shown, path is $path"
            }
            advance()
        }
        assertTrue("the pill left its path in ${offPath.size} frames:\n" + offPath.take(12).joinToString("\n"), offPath.isEmpty())
        val landed = composedPill()!!
        assertEquals("landed on spot $to", x1, landed.first, 3f)
        assertEquals("landed on spot $to", y1, landed.second, 3f)
    }

    @Test
    fun `the pill stays on its path when picked up, dragged and let go on the other spot`() {
        dragAndCheck(from = 0, to = 1, steps = 40)
        dragAndCheck(from = 1, to = 0, steps = 40)
    }

    @Test
    fun `the canvas window is placed once, over the whole screen, and never moves or resizes`() {
        val (x0, y0) = spotCenter(0)
        val (x1, y1) = spotCenter(1)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        for (i in 1..30) {
            touch(MotionEvent.ACTION_MOVE, x0 + (x1 - x0) * i / 30f, y0 + (y1 - y0) * i / 30f)
            composedPill()
            advance()
        }
        touch(MotionEvent.ACTION_UP, x1, y1)
        repeat(120) { composedPill(); advance() }
        view.render(DictationState.Listening(0, 0.3f))
        repeat(60) { composedPill(); advance() }
        view.render(DictationState.Idle)
        repeat(60) { composedPill(); advance() }
        assertEquals("canvas frames requested: ${host.canvasFrames}", listOf(screen), host.canvasFrames)
    }
}
