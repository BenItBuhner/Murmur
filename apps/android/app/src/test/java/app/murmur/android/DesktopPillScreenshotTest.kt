package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationMode
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillPresentation
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.OverlayPosition
import app.murmur.android.settings.OverlayShape
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.schemeFromSeed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
import java.io.File
import java.io.FileOutputStream
import java.time.Duration
import kotlin.math.abs
import kotlin.math.roundToInt

/** A Pixel Tablet-class display, landscape: 2560 x 1600 at xhdpi, i.e. 1280 x 800 dp. */
private const val DENSITY = 2f
private const val SCREEN_W = 2560
private const val SCREEN_H = 1600
private const val FRAME_MS = 8L
private const val MORPH_MS = 340L

/** The desktop overlay's margin from the edge plus the pill's padding inside its window (OverlayPillView). */
private const val DESKTOP_EDGE_DP = 40f

/**
 * The desktop presentation of the pill, on a tablet with a keyboard attached: the idle bar and the
 * listening pill sit where the desktop overlay puts them and grow from the same edge; a command
 * session wears the command tint; taking the keyboard away morphs the pill back onto its spot.
 * The frames are written out as PNGs (build/reports/pill-screenshots) so the layout can be seen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1280dp-h800dp-land-xhdpi")
class DesktopPillScreenshotTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val scratch = Canvas(Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888))
    private val palette = PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark = false), dark = false)

    private fun dp(v: Float): Float = v * DENSITY

    private val keyboardDesktop = PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = false)

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply { this.host = this@DesktopPillScreenshotTest.host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        assertEquals(DENSITY, view.resources.displayMetrics.density, 0.0001f)
        view.setPalette(palette)
        view.configure(OverlayShape.PILL, OverlayLayout.DEFAULT)
        view.setScreen(SCREEN_W, SCREEN_H, null)
        view.render(DictationState.Idle)
        settle()
    }

    private fun frames(n: Int) {
        repeat(n) {
            view.draw(scratch)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
    }

    private fun settle() = frames((MORPH_MS / FRAME_MS).toInt() + 8)

    /** The pill's outline, recovered from the touch window the view asked for (it hugs the pill, padded). */
    private fun pillFromTouch(pillH: Float): Box {
        val t = host.touch.last()
        val dy = maxOf(dp(6f), (dp(44f) - pillH) / 2f)
        return Box(t.left + dp(12f), t.top + dy, t.right - dp(12f), t.bottom - dy)
    }

    private fun lightness(argb: Int): Double = Oklch.fromArgb(argb).l

    @Test
    fun `with a keyboard the pill becomes the desktop idle bar at bottom centre and grows from that edge`() {
        val buttonTouch = host.touch.last()
        assertTrue("the floating button rests on its spot near the left edge", buttonTouch.centerX < SCREEN_W * 0.2f)

        view.setPresentation(keyboardDesktop)
        settle()

        // The canvas is a band along the bottom; the idle bar is 56 x 6 dp, centred, 40 dp up.
        val band = host.canvas.last()
        assertEquals(0f, band.left, 0.5f)
        assertEquals(SCREEN_W.toFloat(), band.right, 0.5f)
        val bar = pillFromTouch(dp(6f))
        assertTrue("the band holds the bar and its shadow: $band", band.bottom >= bar.bottom + dp(12f) && band.top < bar.top - dp(100f))
        assertEquals(SCREEN_W / 2f, bar.centerX, 1f)
        assertEquals(SCREEN_H - dp(DESKTOP_EDGE_DP), bar.bottom, 1f)
        assertEquals(dp(56f), bar.width, 1f)
        assertTrue("the bar's touch target is at least 44 dp tall", host.touch.last().height >= dp(44f) - 0.5f)

        val idle = renderDesktop(bar, "idle bar, ready · Ctrl + Meta to dictate")
        assertTrue("the bar is a light surface", lightness(idle.getPixel(bar.centerX.roundToInt(), bar.centerY.roundToInt())) > 0.9)
        assertTrue("above the bar is the scene", lightness(idle.getPixel(bar.centerX.roundToInt(), (bar.top - dp(14f)).roundToInt())) < 0.88)
        save(idle, "keyboard-pill-idle-bar.png")

        // A hands-free session: the pill grows upwards, its bottom edge staying put.
        view.render(DictationState.Listening(7, 0.6f, DictationMode.HANDS_FREE, locked = true))
        frames(4)
        view.render(DictationState.Listening(7, 0.6f, DictationMode.HANDS_FREE, locked = true))
        settle()
        val pill = pillFromTouch(dp(46f))
        assertEquals(bar.bottom, pill.bottom, 1f)
        assertEquals(bar.centerX, pill.centerX, 1f)
        assertEquals(dp(46f), pill.height, 1f)
        assertTrue("dot, waveform, time and the hands-free badge: ${pill.width / DENSITY} dp wide", pill.width > dp(220f))
        val listening = renderDesktop(pill, "hands-free · listening 0:07")
        assertTrue(lightness(listening.getPixel(pill.centerX.roundToInt(), pill.centerY.roundToInt())) > 0.85)
        save(listening, "keyboard-pill-hands-free.png")

        // A command session wears the command tint, the desktop's violet.
        view.render(DictationState.Idle)
        settle()
        view.render(DictationState.Listening(1, 0.5f, DictationMode.COMMAND, locked = false))
        settle()
        val command = pillFromTouch(dp(46f))
        val body = renderDesktop(command, "command · edit the selection by voice").getPixel((command.left + dp(4f)).roundToInt(), command.centerY.roundToInt())
        val tint = Oklch.fromArgb(body)
        assertTrue("command body is tinted violet, was ${Integer.toHexString(body)} (h=${tint.h}, c=${tint.c})", tint.c > 0.015 && tint.h in 240.0..330.0)
        save(renderDesktop(command, "command · edit the selection by voice"), "keyboard-pill-command.png")

        // The keyboard is taken away: back to the floating button on its spot.
        view.render(DictationState.Idle)
        settle()
        view.setPresentation(PillPresentation.Button)
        settle()
        assertTrue(host.touch.last().approximately(buttonTouch, 1.5f))
    }

    @Test
    fun `the other desktop positions`() {
        view.setPresentation(PillPresentation.Desktop(OverlayPosition.TOP_CENTER, showIdle = true, touchControls = false))
        settle()
        val top = pillFromTouch(dp(6f))
        assertEquals(SCREEN_W / 2f, top.centerX, 1f)
        assertTrue("the bar hangs from the top margin: ${top.top / DENSITY} dp", top.top / DENSITY in 28f..80f)

        view.setPresentation(PillPresentation.Desktop(OverlayPosition.BOTTOM_RIGHT, showIdle = true, touchControls = false))
        settle()
        val right = pillFromTouch(dp(6f))
        assertEquals(SCREEN_W - dp(28f) - dp(180f), right.centerX, 1f)
        assertEquals(SCREEN_H - dp(DESKTOP_EDGE_DP), right.bottom, 1f)
    }

    @Test
    fun `a touch-only tablet keeps cancel and confirm on the listening pill`() {
        view.setPresentation(PillPresentation.Desktop(OverlayPosition.BOTTOM_CENTER, showIdle = true, touchControls = true))
        settle()
        view.render(DictationState.Listening(2, 0.5f, DictationMode.HANDS_FREE, locked = true))
        settle()
        val withControls = pillFromTouch(dp(46f)).width
        view.setPresentation(keyboardDesktop)
        settle()
        view.render(DictationState.Listening(2, 0.5f, DictationMode.HANDS_FREE, locked = true))
        settle()
        val without = pillFromTouch(dp(46f)).width
        assertEquals("two 34 dp buttons", dp(68f), withControls - without, 1f)
    }

    // ---- the tablet around the pill -------------------------------------------------------------

    private val DESK = 0xFFCFCAC1.toInt()
    private val WINDOW = 0xFFFFFFFF.toInt()
    private val LINE = 0xFFB9B4AC.toInt()
    private val INK = 0xFF3A3F47.toInt()

    /** A document window on a light desk, the pill drawn by the view in screen coordinates, a caption. */
    private fun renderDesktop(pill: Box, caption: String): Bitmap {
        val frame = host.canvas.last()
        assertNotNull(frame)
        val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawColor(DESK)
        // The document.
        paint.color = WINDOW
        canvas.drawRoundRect(RectF(dp(120f), dp(64f), SCREEN_W - dp(120f), SCREEN_H - dp(96f)), dp(12f), dp(12f), paint)
        paint.color = LINE
        var y = dp(120f)
        val widths = listOf(0.62f, 0.7f, 0.55f, 0.66f, 0.4f, 0.0f, 0.6f, 0.68f, 0.5f)
        for (w in widths) {
            if (w > 0f) canvas.drawRoundRect(RectF(dp(168f), y, dp(168f) + (SCREEN_W - dp(336f)) * w, y + dp(10f)), dp(5f), dp(5f), paint)
            y += dp(26f)
        }
        // The caret at the end of the last line.
        paint.color = INK
        canvas.drawRect(dp(168f) + (SCREEN_W - dp(336f)) * 0.5f + dp(6f), y - dp(26f) - dp(4f), dp(168f) + (SCREEN_W - dp(336f)) * 0.5f + dp(8f), y - dp(26f) + dp(14f), paint)

        canvas.save()
        canvas.translate(frame.left, frame.top)
        view.draw(canvas)
        canvas.restore()

        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = INK; textSize = dp(12f) }
        canvas.drawText("Tablet · 2560 × 1600 @ xhdpi (1280 × 800 dp) · keyboard attached · desktop pill, bottom centre", dp(24f), dp(36f), text)
        canvas.drawText(caption, dp(24f), SCREEN_H - dp(60f), text)
        canvas.drawText("pill ${(pill.width / DENSITY).roundToInt()} × ${(pill.height / DENSITY).roundToInt()} dp, bottom edge ${((SCREEN_H - pill.bottom) / DENSITY).roundToInt()} dp up", dp(24f), SCREEN_H - dp(40f), text)
        return bitmap
    }

    private fun save(bitmap: Bitmap, name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let(::File) ?: return
        dir.mkdirs()
        FileOutputStream(File(dir, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Suppress("unused")
    private fun near(a: Float, b: Float, eps: Float = 1f): Boolean = abs(a - b) <= eps
}
