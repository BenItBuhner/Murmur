package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.inference.LimitNotice
import app.murmur.android.inference.ServiceNotice
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
private const val TOUCH_PAD = 6 * DENSITY

/**
 * A Murmur service that is down (`provider_unavailable`): the pill grows into the same calm
 * two-line notice as a plan limit, in its own colour, with Retry (its own tap target) and a dismiss
 * cross, and nothing else to tap; without a kept recording there is no Retry; the pill comes back
 * to its resting size afterwards.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillNoticeTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val retries = ArrayList<String>()
    private val upgrades = ArrayList<String>()
    private var ownModel = 0
    private var dismissals = 0
    private var micTaps = 0
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private var downTime = 0L

    private val speechDown = ServiceNotice(
        service = ServiceNotice.SPEECH, reason = "timeout", retryAfterSec = 15,
        message = "Murmur's speech service is unavailable right now"
    )

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply {
            this.host = this@OverlayPillNoticeTest.host
            onRetryTap = { retries += it }
            onUpgradeTap = { upgrades += it }
            onOwnModelTap = { ownModel++ }
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

    private fun pill(): Box = host.touch.last().inflate(-TOUCH_PAD)

    /** Where the chip row sits: right-aligned along the bottom row. */
    private fun chipRowY(box: Box): Float = box.bottom - 12 * DENSITY - 15 * DENSITY

    @Test
    fun `a service that is down grows a two-line notice with Retry and a dismiss cross, and nothing else to tap`() {
        view.render(DictationState.Error("The server took too long to respond", retryId = "entry-1"))
        settle()
        val retryable = pill()

        view.render(DictationState.Error(speechDown.message, retryId = "entry-1", service = speechDown))
        settle()
        val notice = pill()
        assertTrue("taller than a pill: ${retryable.height} -> ${notice.height}", notice.height > retryable.height + 40 * DENSITY)
        assertTrue("about as wide as the screen allows", notice.width > 320 * DENSITY)

        // The dismiss cross sits at the top right (12 dp margin, 14 dp radius, on the title row).
        val titleY = notice.top + 12 * DENSITY + 10 * DENSITY
        tap(notice.right - 26 * DENSITY, titleY)
        assertEquals(1, dismissals)

        // The chip row holds Retry alone, at the right edge.
        val y = chipRowY(notice)
        tap(notice.right - 12 * DENSITY - 20 * DENSITY, y)
        assertEquals(listOf("entry-1"), retries)
        // Left of it there is nothing to tap: no Own model, no Upgrade.
        val retryW = 24 * DENSITY + measure("Retry")
        tap(notice.right - 12 * DENSITY - retryW - 6 * DENSITY - 40 * DENSITY, y)
        tap(notice.left + 40 * DENSITY, y)
        assertEquals(0, ownModel)
        assertTrue(upgrades.isEmpty())
        assertEquals(listOf("entry-1"), retries)

        // The text itself is not a button, and the mic never fires from the notice.
        tap(notice.left + 60 * DENSITY, titleY)
        assertEquals(1, dismissals)
        assertEquals(0, micTaps)

        view.render(DictationState.Idle)
        settle()
        assertTrue(pill().height < retryable.height)
    }

    @Test
    fun `a notice without a kept recording has no Retry, and a limit still wins over a notice`() {
        view.render(DictationState.Error(speechDown.message, retryId = null, service = speechDown))
        settle()
        val notice = pill()
        assertTrue("still the two-line notice: ${notice.height}", notice.height > 90 * DENSITY)
        tap(notice.right - 12 * DENSITY - 20 * DENSITY, chipRowY(notice))
        assertTrue(retries.isEmpty())
        assertEquals(0, dismissals)
        tap(notice.right - 26 * DENSITY, notice.top + 12 * DENSITY + 10 * DENSITY)
        assertEquals(1, dismissals)

        // An error carrying both is a limit refusal first: its Own model chip is there to tap.
        val words = LimitNotice(
            limit = "wordsPerWeek", plan = "free", planState = "free", used = 503.0, allowed = 500.0,
            resetsAt = null, upgradeUrl = null, accountUrl = null, message = "This week's 500 free words are used up."
        )
        view.render(DictationState.Error(words.message, retryId = null, limit = words, service = speechDown))
        settle()
        val limit = pill()
        tap(limit.right - 12 * DENSITY - 20 * DENSITY, chipRowY(limit))
        assertEquals(1, ownModel)
    }

    /** Width of a chip label in the pill's small text paint (12 sp, sans-serif-medium). */
    private fun measure(label: String): Float {
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textSize = 12f * view.resources.displayMetrics.scaledDensity
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
        }
        return paint.measureText(label)
    }
}
