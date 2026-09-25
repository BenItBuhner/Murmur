package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.OverlayShape
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
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val KEYBOARD_TOP = 1500
private const val DENSITY = 3f
private const val FRAME_MS = 8L
private const val PILL_W = 64 * DENSITY
private const val PILL_H = 36 * DENSITY
private const val WINDOW_MOVE_MS = 400f

/**
 * The keyboard's travel per 8 ms frame as Bennett's recording shows it on One UI (frames 907-931
 * opening, 751-764 closing), as a fraction of the way up. Used to move the keyboard's top edge
 * frame by frame the way Samsung Keyboard moves.
 */
private val OPENING = floatArrayOf(
    0f, 0.084f, 0.217f, 0.398f, 0.558f, 0.655f, 0.724f, 0.787f, 0.829f, 0.861f, 0.893f, 0.914f, 0.933f,
    0.951f, 0.962f, 0.971f, 0.982f, 0.988f, 0.992f, 0.997f, 0.999f, 1f
)
private val CLOSING = floatArrayOf(
    1f, 0.985f, 0.942f, 0.848f, 0.675f, 0.516f, 0.391f, 0.291f, 0.219f, 0.164f, 0.11f, 0.06f, 0.02f, 0f
)

/**
 * The resting button is parked relative to the keyboard's top edge, so wherever the pill learns the
 * keyboard's top to be, it must be drawn there in that same frame: the recording shows it easing
 * after the keyboard for 240 ms instead (frames 940-960, 1262-1283, 1644-1688) and, whenever the
 * keyboard rose, dropping first and then easing up (frames 1425, 1444, 1461, 1480) because its
 * canvas window grew upwards and WindowManager animated the move.
 *
 * Each frame here hands the view a new keyboard top, draws, and checks where the screen shows the
 * pill: the canvas window's pixels placed where WindowManager has its surface (see
 * [OverlayPillCompositionTest] for that model).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillKeyboardTest {

    private class CompositorHost : OverlayPillView.Host {
        var frame: Box? = null
            private set
        private var animFrom = 0f to 0f
        private var animElapsed = WINDOW_MOVE_MS

        override fun applyCanvasFrame(frame: Box) {
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

        fun shownOrigin(): Pair<Float, Float> {
            val f = frame ?: return 0f to 0f
            if (animElapsed >= WINDOW_MOVE_MS) return f.left to f.top
            val v = 1f - (1f - animElapsed / WINDOW_MOVE_MS).pow(5)
            return (animFrom.first + (f.left - animFrom.first) * v) to (animFrom.second + (f.top - animFrom.second) * v)
        }

        fun tick() {
            animElapsed += FRAME_MS
        }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: CompositorHost
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private val pixels = IntArray(SCREEN_W * SCREEN_H)

    /** Just above the keyboard, in the middle: it has to travel with the keyboard's top edge. */
    private val aboveKeyboard = OverlayLayout(listOf(OverlayAnchor(0.5f, 25f)))

    @Before
    fun setUp() {
        host = CompositorHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply { host = this@OverlayPillKeyboardTest.host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, aboveKeyboard)
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        repeat(60) { composedPill(); advance() }
    }

    private fun advance() {
        host.tick()
        ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
        ShadowLooper.idleMainLooper()
    }

    private fun expectedCenter(keyboardTop: Int, spot: OverlayAnchor = aboveKeyboard.active): Pair<Float, Float> =
        OverlayGeometry.anchorPoint(spot, SCREEN_W.toFloat(), SCREEN_H.toFloat(), keyboardTop.toFloat(), DENSITY, PILL_W, PILL_H)

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

    /** Moves the keyboard's top edge through [tops], one per frame, and lists every frame the pill is not where the keyboard puts it. */
    private fun follow(tops: List<Int>, spot: OverlayAnchor = aboveKeyboard.active): List<String> {
        val misses = ArrayList<String>()
        for ((i, top) in tops.withIndex()) {
            view.setScreen(SCREEN_W, SCREEN_H, top)
            val (ex, ey) = expectedCenter(top, spot)
            val shown = composedPill()
            if (shown == null || abs(shown.first - ex) > 1.5f || abs(shown.second - ey) > 1.5f) {
                misses += "frame $i: keyboard top $top, pill shown at $shown, belongs at ($ex, $ey)"
            }
            advance()
        }
        return misses
    }

    private fun travel(curve: FloatArray, rest: Int, gone: Int): List<Int> =
        curve.map { p -> (gone + (rest - gone) * p).roundToInt() } + List(30) { (gone + (rest - gone) * curve.last()).roundToInt() }

    @Test
    fun `the pill is where the keyboard's top edge puts it in every frame while the keyboard moves`() {
        // The app drags the keyboard down with a scroll and lets it spring back (recording, 3.2-4.5 s).
        val drag = (0..12).map { KEYBOARD_TOP + it * 8 } + (12 downTo 0).map { KEYBOARD_TOP + it * 8 }
        // The keyboard grows (a toolbar or the number row appears) and shrinks back.
        val resize = List(20) { KEYBOARD_TOP - 132 } + List(20) { KEYBOARD_TOP }
        val misses = follow(drag) + follow(resize)
        assertTrue("the pill lagged the keyboard in ${misses.size} frames:\n" + misses.take(12).joinToString("\n"), misses.isEmpty())
    }

    @Test
    fun `the pill travels with the keyboard frame by frame as it opens and closes`() {
        // Offered one keyboard top per frame, as Samsung Keyboard moves on the recording.
        val misses = follow(travel(CLOSING, rest = KEYBOARD_TOP, gone = SCREEN_H)) +
            follow(travel(OPENING, rest = KEYBOARD_TOP, gone = SCREEN_H))
        assertTrue("the pill lagged the keyboard in ${misses.size} frames:\n" + misses.take(12).joinToString("\n"), misses.isEmpty())
    }

    @Test
    fun `a spot over the keyboard stays pinned to the screen edge the clamp holds it at`() {
        // The recording's corner spot, as low as the edge lets it go: a taller keyboard lifts it, a shorter one cannot push it off screen.
        val corner = OverlayLayout(listOf(OverlayAnchor(0.11f, -323f)))
        view.configure(OverlayShape.PILL, corner)
        repeat(60) { composedPill(); advance() }
        val misses = follow(List(20) { KEYBOARD_TOP - 200 } + List(20) { KEYBOARD_TOP + 60 } + List(20) { KEYBOARD_TOP }, corner.active)
        assertTrue("the pill lagged the keyboard in ${misses.size} frames:\n" + misses.take(12).joinToString("\n"), misses.isEmpty())
    }
}
