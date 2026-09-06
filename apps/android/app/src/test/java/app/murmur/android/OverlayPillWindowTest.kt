package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayMotion
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillTheme
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
private const val FRAME_MS = 8L

/**
 * The windows the pill asks its host for. Moving a window and redrawing into it are not atomic on
 * Android, so the window the pill is drawn in must not move while the mic turns on and off: the
 * recording that motivated this showed the pill jumping 5 dp for a few frames at every idle
 * transition, once when the window grew for the morph and once when it was tightened afterwards.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillWindowTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply { this.host = this@OverlayPillWindowTest.host }
        // Attached to a real window so the view's deferred (posted) work runs.
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.CIRCLE, OverlayAnchor(0.07f, -20f))
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        frames(10)
    }

    /** Advance [n] frames at ~120 Hz, drawing each one so morphs progress and settle. */
    private fun frames(n: Int) {
        repeat(n) {
            view.draw(canvas)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
    }

    private fun settle() = frames((OverlayMotion.MORPH_MS / FRAME_MS).toInt() + 6)

    private fun listen(ms: Long) {
        var t = 0L
        while (t < ms) {
            view.render(DictationState.Listening((t / 1000).toInt(), 0.4f))
            frames(1)
            t += FRAME_MS
        }
    }

    @Test
    fun `the canvas window is placed once for a whole dictation`() {
        assertEquals(1, host.canvas.size)
        val placed = host.canvas.single()

        view.render(DictationState.Listening(0, 0.2f)); listen(700)
        view.render(DictationState.Idle); settle()
        view.render(DictationState.Listening(0, 0.2f)); listen(500)
        view.render(DictationState.Processing("Transcribing…")); settle()
        view.render(DictationState.Processing("Formatting…")); settle()
        view.render(DictationState.Success("Inserted")); settle()
        view.render(DictationState.Idle); settle()

        assertEquals("no canvas relayout during the cycle: ${host.canvas}", 1, host.canvas.size)
        // Meanwhile the touch window followed the pill (grew for the morph, tightened after it) and
        // always stayed inside the canvas.
        assertTrue(host.touch.size >= 8)
        for (t in host.touch) assertTrue("$t outside $placed", placed.encloses(t))
        val idleTouch = host.touch.first()
        assertTrue(host.touch.last().approximately(idleTouch))
        assertTrue(host.touch.maxOf { it.width } > idleTouch.width * 3)
    }

    @Test
    fun `a theme change does not move the canvas either`() {
        view.setPalette(PillTheme.fromAccent(0xFF6699FF.toInt(), 0xFF101418.toInt()))
        settle()
        assertEquals(1, host.canvas.size)
    }

    @Test
    fun `the canvas only grows when the anchor moves, and not again when it moves back`() {
        val before = host.canvas.single()
        // The keyboard's suggestion strip appears: the anchor rises with it.
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP - 120); settle()
        assertEquals(2, host.canvas.size)
        val grown = host.canvas.last()
        assertTrue(grown.encloses(before))
        assertTrue(grown.top < before.top)
        // ...and goes away again: the canvas already covers that, so nothing happens.
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP); settle()
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP - 120); settle()
        assertEquals(2, host.canvas.size)
    }

    @Test
    fun `edit mode takes the whole screen and hands it back afterwards`() {
        val resting = host.canvas.single()
        view.setEditing(true); settle()
        assertEquals(Box(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat()), host.canvas.last())
        assertEquals(Box(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat()), host.touch.last())
        view.setEditing(false); settle()
        assertTrue(host.canvas.last().approximately(resting))
        assertTrue(resting.encloses(host.touch.last()))
    }
}
