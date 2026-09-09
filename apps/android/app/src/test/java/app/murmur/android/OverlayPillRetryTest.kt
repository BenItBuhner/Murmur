package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
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

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val KEYBOARD_TOP = 1500
private const val DENSITY = 3f
private const val FRAME_MS = 8L

/** OverlayPillView.TOUCH_PAD_DP: how far past the pill its touch window reaches. */
private const val TOUCH_PAD = 6 * DENSITY

/**
 * An error whose recording was kept offers to send it again: the pill grows a Retry chip and a
 * dismiss cross, each with its own tap target, and the message gives way to make room. A plain
 * error (no recording) keeps the old look and stays inert.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillRetryTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val retries = ArrayList<String>()
    private var dismissals = 0
    private var micTaps = 0
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private var downTime = 0L

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply {
            this.host = this@OverlayPillRetryTest.host
            onRetryTap = { retries += it }
            onDismissTap = { dismissals++ }
            onMicTap = { micTaps++ }
        }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, OverlayLayout(listOf(OverlayAnchor(0.5f, 30f))))
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        frames(10)
    }

    private fun frames(n: Int) {
        repeat(n) {
            view.draw(canvas)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
    }

    /** Long enough for the outline morph (340 ms) to finish and the touch window to tighten. */
    private fun settle() = frames(120)

    private fun tap(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        downTime = now
        val down = MotionEvent.obtain(downTime, now, MotionEvent.ACTION_DOWN, x, y, 0)
        view.onScreenTouch(down, x, y)
        down.recycle()
        frames(2)
        val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
        view.onScreenTouch(up, x, y)
        up.recycle()
        frames(1)
    }

    /** The pill's own outline: the touch window hugs it with TOUCH_PAD around. */
    private fun pill(): Box = host.touch.last().inflate(-TOUCH_PAD)

    @Test
    fun `a retryable error grows Retry and dismiss controls with their own tap targets`() {
        view.render(DictationState.Error("The server took too long to respond"))
        settle()
        val plain = pill()

        view.render(DictationState.Error("The server took too long to respond", retryId = "entry-1"))
        settle()
        val retryable = pill()
        assertTrue("room for the controls: $plain -> $retryable", retryable.width > plain.width + 40 * DENSITY)

        // The dismiss cross sits at the right edge (9 dp margin, 14 dp radius); the Retry chip
        // directly to its left.
        val cy = retryable.centerY
        tap(retryable.right - 23 * DENSITY, cy)
        assertEquals(1, dismissals)
        assertEquals(emptyList<String>(), retries)

        tap(retryable.right - 75 * DENSITY, cy)
        assertEquals(listOf("entry-1"), retries)
        assertEquals(1, dismissals)

        // The message itself is not a button.
        tap(retryable.left + 60 * DENSITY, cy)
        assertEquals(listOf("entry-1"), retries)
        assertEquals(1, dismissals)
        assertEquals(0, micTaps)
    }

    @Test
    fun `an error without a recording stays inert`() {
        view.render(DictationState.Error("Too short"))
        settle()
        val box = pill()
        tap(box.right - 23 * DENSITY, box.centerY)
        tap(box.centerX, box.centerY)
        assertEquals(0, dismissals)
        assertTrue(retries.isEmpty())
        assertEquals(0, micTaps)
    }

    @Test
    fun `the touch window follows the wider retry pill and comes back afterwards`() {
        val idle = host.touch.last()
        view.render(DictationState.Error("Provider error: upstream exploded", retryId = "entry-2"))
        settle()
        assertTrue(host.touch.last().width > idle.width * 3)
        view.render(DictationState.Idle)
        settle()
        assertTrue(host.touch.last().approximately(idle))
    }
}
