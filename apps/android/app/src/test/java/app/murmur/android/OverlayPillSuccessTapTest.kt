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
import app.murmur.android.overlay.PillPresentation
import app.murmur.android.settings.OverlayPosition
import app.murmur.android.settings.OverlayShape
import org.junit.Assert.assertEquals
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
 * The "Inserted" message after a dictation is not a wait: a tap on it starts the next dictation at
 * once, also while the pill is still morphing into the message, instead of being swallowed until
 * the mic comes back.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillSuccessTapTest {

    private class RecordingHost : OverlayPillView.Host {
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) {}
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private var micTaps = 0
    private var confirmTaps = 0
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply {
            this.host = this@OverlayPillSuccessTapTest.host
            onMicTap = { micTaps++ }
            onConfirmTap = { confirmTaps++ }
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

    private fun settle() = frames(120)

    private fun tap(x: Float, y: Float) {
        val downTime = SystemClock.uptimeMillis()
        val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
        view.onScreenTouch(down, x, y)
        down.recycle()
        frames(2)
        val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
        view.onScreenTouch(up, x, y)
        up.recycle()
        frames(1)
    }

    private fun pill(): Box = host.touch.last().inflate(-TOUCH_PAD)

    @Test
    fun `a tap on Inserted starts the next dictation`() {
        view.render(DictationState.Success("Inserted"))
        settle()
        val box = pill()
        tap(box.centerX, box.centerY)
        assertEquals(1, micTaps)
        assertEquals(0, confirmTaps)
    }

    @Test
    fun `a tap while the pill is still turning into Inserted starts it too`() {
        view.render(DictationState.Processing("Transcribing…"))
        settle()
        val processing = pill()
        view.render(DictationState.Success("Inserted"))
        frames(3)
        tap(processing.centerX, processing.centerY)
        assertEquals(1, micTaps)
    }

    @Test
    fun `the next dictation's pill grows straight out of the message`() {
        view.render(DictationState.Success("Inserted"))
        settle()
        val success = pill()
        tap(success.centerX, success.centerY)
        // The controller answers the tap by listening; the pill morphs there without passing the mic.
        view.render(DictationState.Listening(0, 0f))
        settle()
        val listening = pill()
        tap(listening.centerX, listening.centerY)
        assertEquals(1, micTaps)
        assertEquals(1, confirmTaps)
    }

    @Test
    fun `a desktop bar that lets taps through does not start one from Inserted`() {
        view.setPresentation(PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = false, idleTap = false))
        view.render(DictationState.Success("Inserted"))
        settle()
        val box = pill()
        tap(box.centerX, box.centerY)
        assertEquals(0, micTaps)
    }
}
