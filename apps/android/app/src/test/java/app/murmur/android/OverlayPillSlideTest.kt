package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.SystemClock
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.OverlayShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
private const val SLIDE_IN_MS = 280L // OverlayPillView.SLIDE_IN_MS
private const val SLIDE_OUT_MS = 220L // OverlayPillView.SLIDE_OUT_MS

/**
 * With no keyboard on screen the pill has nothing to arrive or leave with: it rises from below the
 * bottom edge of the screen to its spot, and sinks back down out of sight when it goes, rather than
 * popping in and out where it rests. Turning round mid-way is smooth, and a keyboard coming up under
 * a pill shown without one moves it there over frames instead of in one jump.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillSlideTest {

    private class RecordingHost : OverlayPillView.Host {
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) {}
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
        view = OverlayPillView(activity).apply { this.host = this@OverlayPillSlideTest.host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, OverlayLayout(listOf(OverlayAnchor(0.5f, 30f))))
        view.setScreen(SCREEN_W, SCREEN_H, null)
        view.render(DictationState.Idle)
        frames(10)
    }

    /** Draws one frame and returns the topmost row anything was painted in, or null if nothing was. */
    private fun frame(): Int? {
        bitmap.eraseColor(Color.TRANSPARENT)
        view.draw(canvas)
        ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
        ShadowLooper.idleMainLooper()
        return paintedTop()
    }

    private fun frames(n: Int): List<Int?> = (1..n).map { frame() }

    private fun paintedTop(): Int? {
        val row = IntArray(SCREEN_W)
        for (y in 0 until SCREEN_H) {
            bitmap.getPixels(row, 0, SCREEN_W, 0, y, SCREEN_W, 1)
            if (row.any { Color.alpha(it) > 0 }) return y
        }
        return null
    }

    /** Where the pill's paint starts when it simply sits at its spot. */
    private fun restingTop(): Int = frames(30).last()!!

    private fun showFromBottom() {
        view.restart()
        view.setScreen(SCREEN_W, SCREEN_H, null)
        view.render(DictationState.Idle)
        view.slideIn()
    }

    /** Draws frames until [done] holds for the painted top (at most [max]); returns (tops seen, ms taken). */
    private fun framesUntil(max: Int = 60, done: (Int?) -> Boolean): Pair<List<Int?>, Long> {
        val started = SystemClock.uptimeMillis()
        val tops = ArrayList<Int?>()
        repeat(max) {
            val drawnAt = SystemClock.uptimeMillis()
            val top = frame()
            tops += top
            if (done(top)) return tops to (drawnAt - started)
        }
        return tops to -1L
    }

    @Test
    fun `shown with no keyboard it rises from below the bottom edge to its spot`() {
        val rest = restingTop()

        showFromBottom()
        val (tops, took) = framesUntil { it == rest }
        assertNull("first frame: still below the bottom edge", tops.first())
        val seen = tops.filterNotNull()
        assertTrue("seen on the way up: $tops", seen.size >= 4)
        assertTrue("comes up from the bottom edge: $seen", seen.first() > SCREEN_H - 250)
        assertTrue("only ever rises: $seen", seen.zipWithNext().all { (a, b) -> b <= a })
        assertTrue("about SLIDE_IN_MS to arrive: ${took}ms", took in (SLIDE_IN_MS - 60)..(SLIDE_IN_MS + 80))
        assertTrue("and stays there: ", frames(10).all { it == rest })
        assertFalse(view.isDismissing)
    }

    @Test
    fun `going with no keyboard it sinks off the bottom of the screen, then is gone`() {
        val rest = restingTop()
        var gone = 0
        view.slideAway { gone++ }
        assertTrue("going: taps no longer land", view.isDismissing)

        val (tops, took) = framesUntil { it == null }
        assertTrue("out of sight in about SLIDE_OUT_MS: ${took}ms $tops", took in (SLIDE_OUT_MS - 60)..(SLIDE_OUT_MS + 80))
        val seen = tops.filterNotNull()
        assertTrue("seen on the way down: $tops", seen.size >= 4)
        assertTrue("only ever sinks: $seen", seen.zipWithNext().all { (a, b) -> b >= a })
        assertTrue("starts from its spot: $seen", seen.first() <= rest + 10)
        assertTrue("near the bottom edge before it goes: $seen", seen.last() > SCREEN_H - 250)
        assertTrue("nothing painted once it is down", frames(10).all { it == null })
        assertEquals("told once it is out of sight", 1, gone)
    }

    @Test
    fun `brought back while sinking it rises from where it had got to, and never goes`() {
        val rest = restingTop()
        var gone = 0
        view.slideAway { gone++ }
        val down = frames(4).last()!!
        assertTrue("on its way down: $down", down > rest + 10)

        view.appear()
        assertFalse(view.isDismissing)
        val tops = frames(30).map { it!! }
        assertTrue("turns round without jumping: ${tops.first()} after $down", abs(tops.first() - down) < 80)
        assertTrue("only rises again: $tops", tops.zipWithNext().all { (a, b) -> b <= a })
        assertEquals(rest, tops.last())
        assertEquals("never told it was gone", 0, gone)
    }

    @Test
    fun `a keyboard coming up under a pill shown without one moves it there over frames`() {
        val rest = restingTop()
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        val tops = frames(30).map { it!! }
        val atKeyboard = tops.last()
        assertTrue("moved up to the keyboard: $rest -> $atKeyboard", atKeyboard < rest - 200)
        val between = tops.count { it < rest - 1 && it > atKeyboard + 1 }
        assertTrue("passes through frames in between, not one jump: $tops", between >= 3)

        // A keyboard already up nudging its edge still takes the pill with it at once, as before.
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP - 100)
        assertEquals(atKeyboard - 100, frame()!!)
    }

    private fun abs(x: Int) = kotlin.math.abs(x)
}
