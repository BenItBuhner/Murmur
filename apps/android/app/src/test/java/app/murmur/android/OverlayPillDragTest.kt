package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.OverlayShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val KEYBOARD_TOP = 1500
private const val DENSITY = 3f
private const val FRAME_MS = 8L

/** The resting pill (OverlayPillView's idle look for OverlayShape.PILL) at xxhdpi. */
private const val PILL_W = 64 * DENSITY
private const val PILL_H = 36 * DENSITY

/** OverlayPillView.TOUCH_PAD_DP: how far past the pill its touch window reaches. */
private const val TOUCH_PAD = 6 * DENSITY

/**
 * Dragging the resting button between its spots, driven through the same entry point the
 * accessibility service uses ([OverlayPillView.onScreenTouch], screen coordinates). The one thing
 * a user does with this feature is pick the button up while the keyboard is showing, move it, and
 * let go; these tests hold the view to that, including right after a dictation (which is when the
 * button is most often in the way, and where the first version of the feature went dead).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillDragTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    /** Centred above the keyboard and at the right edge of the same row (the default layout). */
    private val twoSpots = OverlayLayout(
        listOf(OverlayAnchor(0.5f, 30f), OverlayAnchor(1f, 30f)),
        activeIndex = 0
    )

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val layoutChanges = ArrayList<OverlayLayout>()
    private var micTaps = 0
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private val pixels = IntArray(SCREEN_W * SCREEN_H)
    private var downTime = 0L
    private val screen = Box(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat())

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply {
            this.host = this@OverlayPillDragTest.host
            onLayoutChanged = { layoutChanges += it }
            onMicTap = { micTaps++ }
        }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, twoSpots)
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        frames(10)
    }

    // ---- helpers --------------------------------------------------------------------------------

    private fun frames(n: Int) {
        repeat(n) {
            view.draw(canvas)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
    }

    /** Long enough for the outline morph (340 ms) or the landing spring to finish. */
    private fun settle() = frames(120)

    private fun spotCenter(index: Int): Pair<Float, Float> =
        OverlayGeometry.anchorPoint(twoSpots.spots[index], SCREEN_W.toFloat(), SCREEN_H.toFloat(), KEYBOARD_TOP.toFloat(), DENSITY, PILL_W, PILL_H)

    private fun idleTouchBox(index: Int): Box {
        val (x, y) = spotCenter(index)
        return Box.centered(x, y, PILL_W, PILL_H).inflate(TOUCH_PAD).intersect(screen)
    }

    private fun touch(action: Int, x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        if (action == MotionEvent.ACTION_DOWN) downTime = now
        val event = MotionEvent.obtain(downTime, now, action, x, y, 0)
        view.onScreenTouch(event, x, y)
        event.recycle()
    }

    /** Move the finger from where it is to (x, y) in [steps] samples, a frame apart. */
    private fun moveTo(fromX: Float, fromY: Float, x: Float, y: Float, steps: Int) {
        for (i in 1..steps) {
            val t = i.toFloat() / steps
            touch(MotionEvent.ACTION_MOVE, fromX + (x - fromX) * t, fromY + (y - fromY) * t)
            frames(1)
        }
    }

    private fun dictate() {
        view.render(DictationState.Listening(0, 0.3f))
        repeat(60) { view.render(DictationState.Listening(0, 0.4f)); frames(1) }
        view.render(DictationState.Processing("Transcribing…")); settle()
        view.render(DictationState.Success("Inserted")); settle()
        view.render(DictationState.Idle); settle()
    }

    /**
     * Where the pill body is drawn right now, in the canvas window's coordinates: the bounding box
     * of its opaque dark pixels. Ghost spots are translucent, the highlight is the accent colour,
     * the shadow is faint and the mic icon sits inside the body, so none of them widen the box.
     */
    private fun drawnPill(): Box {
        bitmap.eraseColor(Color.TRANSPARENT)
        view.draw(canvas)
        bitmap.getPixels(pixels, 0, SCREEN_W, 0, 0, SCREEN_W, SCREEN_H)
        var left = SCREEN_W
        var top = SCREEN_H
        var right = -1
        var bottom = -1
        for (y in 0 until SCREEN_H) {
            val row = y * SCREEN_W
            for (x in 0 until SCREEN_W) {
                val p = pixels[row + x]
                if (Color.alpha(p) < 230 || Color.red(p) > 0x30 || Color.green(p) > 0x30 || Color.blue(p) > 0x30) continue
                if (x < left) left = x
                if (x > right) right = x
                if (y < top) top = y
                if (y > bottom) bottom = y
            }
        }
        assertTrue("no pill body drawn", right >= left && bottom >= top)
        return Box(left.toFloat(), top.toFloat(), right + 1f, bottom + 1f)
    }

    private fun assertNear(message: String, expected: Float, actual: Float, tolerance: Float) {
        assertTrue("$message: expected $expected, was $actual", abs(expected - actual) <= tolerance)
    }

    // ---- tests ----------------------------------------------------------------------------------

    @Test
    fun `the button follows the finger and lands on the nearest spot`() {
        val (x0, y0) = spotCenter(0)
        val (x1, y1) = spotCenter(1)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        frames(1)
        // Well past the slop and clear of both spots: the button is wherever the finger is.
        moveTo(x0, y0, x0 + 150f, y0 - 200f, 6)
        val held = drawnPill()
        assertEquals("the canvas covers the screen while dragging", screen, host.canvas.last())
        assertNear("pill follows the finger horizontally", x0 + 150f, held.centerX, 3f)
        assertNear("pill follows the finger vertically", y0 - 200f, held.centerY, 3f)
        assertTrue("the held button is drawn slightly enlarged", held.width > PILL_W && held.width < PILL_W * 1.2f)

        // Carry on to just short of the right-hand spot and let go there.
        moveTo(x0 + 150f, y0 - 200f, x1 - 40f, y1 + 20f, 8)
        touch(MotionEvent.ACTION_UP, x1 - 40f, y1 + 20f)
        assertEquals(listOf(1), layoutChanges.map { it.activeIndex })
        settle()

        assertTrue("the canvas hands the screen back after landing", host.canvas.last() != screen)
        assertTrue("the touch window hugs the button on its new spot: ${host.touch.last()}", host.touch.last().approximately(idleTouchBox(1), 1f))
        assertTrue(host.canvas.last().encloses(host.touch.last()))
        assertEquals("a drag is not a tap", 0, micTaps)
    }

    @Test
    fun `the button can still be dragged after a dictation`() {
        dictate()
        val (x0, y0) = spotCenter(0)
        val (x1, y1) = spotCenter(1)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        frames(1)
        moveTo(x0, y0, x1 - 30f, y1, 10)
        val held = drawnPill()
        assertNear("the button moved with the finger", x1 - 30f, held.centerX, 3f)
        touch(MotionEvent.ACTION_UP, x1 - 30f, y1)
        settle()
        assertEquals(listOf(1), layoutChanges.map { it.activeIndex })
        assertTrue(host.touch.last().approximately(idleTouchBox(1), 1f))
        assertEquals(0, micTaps)
    }

    @Test
    fun `the button can be grabbed while it is still morphing back to the mic`() {
        view.render(DictationState.Success("Inserted")); settle()
        view.render(DictationState.Idle)
        frames(4) // ~32 ms into a 340 ms morph
        val (x0, y0) = spotCenter(0)
        val (x1, y1) = spotCenter(1)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, x1 - 30f, y1, 10)
        val held = drawnPill()
        // The "Inserted" pill is ~320 px wide; a finished morph leaves the 192 px button (held: up to 1.08x).
        assertTrue("the grab finished the morph, the plain button is under the finger: ${held.width}", held.width >= PILL_W && held.width < PILL_W * 1.15f)
        assertNear("and it is where the finger is", x1 - 30f, held.centerX, 3f)
        touch(MotionEvent.ACTION_UP, x1 - 30f, y1)
        settle()
        assertEquals(listOf(1), layoutChanges.map { it.activeIndex })
    }

    @Test
    fun `the touch window is left alone while the finger is down`() {
        val (x0, y0) = spotCenter(0)
        val (x1, y1) = spotCenter(1)
        val touchFramesBefore = host.touch.size
        val resting = host.touch.last()
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        frames(1)
        moveTo(x0, y0, x1, y1 - 300f, 12)
        assertEquals("no touch relayout under the finger", touchFramesBefore, host.touch.size)
        assertEquals(screen, host.canvas.last())
        touch(MotionEvent.ACTION_UP, x1, y1 - 300f)
        frames(1)
        // Released: the touch window may move again. It reaches from the release point to the
        // landing spot until the spring settles, then hugs the button.
        assertTrue(host.touch.size > touchFramesBefore)
        val inFlight = host.touch.last()
        assertTrue("$inFlight should cover the release point", inFlight.contains(x1, y1 - 300f))
        assertTrue("$inFlight should cover the landing spot", inFlight.contains(x1, y1))
        settle()
        assertTrue(host.touch.last().approximately(idleTouchBox(1), 1f))
        assertFalse(host.touch.last().approximately(resting, 1f))
        // Only edit mode puts the touch window over the whole screen.
        assertTrue(host.touch.none { it == screen })
    }

    @Test
    fun `it lands on the highlighted spot even when let go at speed`() {
        val (x0, y0) = spotCenter(0)
        val (x1, _) = spotCenter(1)
        // Released before the midpoint between the spots while still moving fast towards the far one.
        val release = (x0 + x1) / 2f - 40f
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, release, y0, 3)
        touch(MotionEvent.ACTION_UP, release, y0)
        settle()
        assertTrue("nearest wins, not momentum: $layoutChanges", layoutChanges.isEmpty())
        assertTrue(host.touch.last().approximately(idleTouchBox(0), 1f))

        // Past the midpoint, the other spot is nearest and is where it goes.
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, (x0 + x1) / 2f + 40f, y0, 3)
        touch(MotionEvent.ACTION_UP, (x0 + x1) / 2f + 40f, y0)
        settle()
        assertEquals(listOf(1), layoutChanges.map { it.activeIndex })
        assertTrue(host.touch.last().approximately(idleTouchBox(1), 1f))
    }

    @Test
    fun `a tap is still a tap`() {
        val (x0, y0) = spotCenter(0)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        frames(2)
        touch(MotionEvent.ACTION_UP, x0, y0)
        assertEquals(1, micTaps)
        // A finger that rolls a few pixels is still tapping.
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        touch(MotionEvent.ACTION_MOVE, x0 + 4f, y0 + 3f)
        frames(1)
        touch(MotionEvent.ACTION_UP, x0 + 4f, y0 + 3f)
        assertEquals(2, micTaps)
        assertTrue(layoutChanges.isEmpty())
        assertTrue(host.canvas.none { it == screen })
    }

    @Test
    fun `a drag put down near where it started goes back without a layout change`() {
        val (x0, y0) = spotCenter(0)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, x0 + 90f, y0 - 260f, 8)
        touch(MotionEvent.ACTION_UP, x0 + 90f, y0 - 260f)
        settle()
        assertTrue(layoutChanges.isEmpty())
        assertTrue(host.touch.last().approximately(idleTouchBox(0), 1f))
        assertNotEquals(screen, host.canvas.last())
        assertEquals(0, micTaps)
    }

    @Test
    fun `a layout with a single spot still lets the button be picked up and springs it back`() {
        view.configure(OverlayShape.PILL, OverlayLayout(listOf(OverlayAnchor(0.5f, 30f))))
        settle()
        val (x0, y0) = spotCenter(0)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, x0 + 300f, y0 - 300f, 8)
        val held = drawnPill()
        assertNear("it follows the finger", x0 + 300f, held.centerX, 3f)
        touch(MotionEvent.ACTION_UP, x0 + 300f, y0 - 300f)
        settle()
        assertTrue(layoutChanges.isEmpty())
        assertTrue(host.touch.last().approximately(idleTouchBox(0), 1f))
    }

    @Test
    fun `the listening pill cannot be dragged`() {
        view.render(DictationState.Listening(0, 0.3f)); settle()
        val touchFrames = host.touch.size
        val (x0, y0) = spotCenter(0)
        touch(MotionEvent.ACTION_DOWN, x0, y0)
        moveTo(x0, y0, x0 + 200f, y0 - 200f, 6)
        touch(MotionEvent.ACTION_UP, x0 + 200f, y0 - 200f)
        settle()
        assertTrue(layoutChanges.isEmpty())
        assertTrue(host.canvas.none { it == screen })
        assertEquals(touchFrames, host.touch.size)
    }
}
