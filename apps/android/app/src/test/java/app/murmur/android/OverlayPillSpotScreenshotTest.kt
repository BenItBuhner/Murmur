package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.DisplayGeometry
import app.murmur.android.overlay.OverlayDefaults
import app.murmur.android.overlay.OverlayGeometry
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.OverlayShape
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.schemeFromSeed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
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
import kotlin.math.roundToInt

/** Galaxy S26 Ultra at its out-of-the-box rendering: 2340 x 1080 at 450 dpi, i.e. 384 x 832 dp. */
private const val DENSITY = 2.8125f
private const val SCREEN_W = 1080
private const val SCREEN_H = 2340

/** The keyboard the spots were tuned with: an IME window 347 dp tall (323 = 347 - 6 margin - 18 half a button). */
private const val KEYBOARD_DP = 347f

/** The radius at which a pill 11 % from the left is concentric with the display's corner; drawn as the bezel here. */
private const val CORNER_DP = 28f

private const val FRAME_MS = 8L

/**
 * The resting pill on spot 1 of the Galaxy S26 Ultra's spots, rendered by the real view on that
 * phone's metrics with its keyboard up, and checked pixel by pixel: it sits in the bottom-left
 * corner, its capsule end concentric with the display's corner, on the edge margin. The frames are
 * also written out as PNGs (under build/reports/pill-screenshots) so the placement can be seen.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
class OverlayPillSpotScreenshotTest {

    private class RecordingHost : OverlayPillView.Host {
        var canvas: Box? = null
        var touch: Box? = null
        override fun applyCanvasFrame(frame: Box) { canvas = frame }
        override fun applyTouchFrame(frame: Box) { touch = frame }
    }

    private fun dp(v: Float): Float = v * DENSITY

    private val keyboardTop = (SCREEN_H - dp(KEYBOARD_DP)).roundToInt()
    private val geometry = DisplayGeometry(widthDp = 384f, heightDp = 832f, cornerRadiusDp = CORNER_DP, model = "SM-S948B")
    private val palette = PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark = false), dark = false)

    private fun expectedPill(layout: OverlayLayout): Box {
        val (cx, cy) = OverlayGeometry.anchorPoint(
            layout.active, SCREEN_W.toFloat(), SCREEN_H.toFloat(), keyboardTop.toFloat(), DENSITY,
            dp(OverlayGeometry.RESTING_W_DP), dp(OverlayGeometry.RESTING_H_DP)
        )
        return Box.centered(cx, cy, dp(OverlayGeometry.RESTING_W_DP), dp(OverlayGeometry.RESTING_H_DP))
    }

    /** The real view, hosted as the accessibility service hosts it, resting on the layout's active spot. */
    private fun restingPill(layout: OverlayLayout, host: RecordingHost): OverlayPillView {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val view = OverlayPillView(activity).apply { this.host = host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        assertEquals(DENSITY, view.resources.displayMetrics.density, 0.0001f)
        view.setPalette(palette)
        view.configure(OverlayShape.PILL, layout)
        view.setScreen(SCREEN_W, SCREEN_H, keyboardTop)
        view.render(DictationState.Idle)
        // A few frames so anything that morphs in has settled.
        val scratch = Canvas(Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888))
        repeat(12) {
            view.draw(scratch)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
        return view
    }

    @Test
    fun `spot 1 parks the pill in the bottom-left corner, concentric with the display's corner`() {
        val layout = OverlayDefaults.layoutFor(geometry)
        assertSame("a Galaxy S26 Ultra takes the hand-tuned spots", OverlayLayout.DEFAULT, layout)
        assertEquals("11% from the left, 323 dp down over the keyboard", layout.active.describe())

        val host = RecordingHost()
        val view = restingPill(layout, host)
        val frame = host.canvas
        assertNotNull("the host was asked for a canvas window", frame)
        val pill = expectedPill(layout)

        // Where the maths puts it: 10.24 dp in from the left, 6 dp (the edge margin) up from the bottom.
        val margin = dp(OverlayGeometry.EDGE_MARGIN_DP)
        assertEquals(0.11f * SCREEN_W - dp(OverlayGeometry.RESTING_W_DP) / 2f, pill.left, 0.01f)
        assertEquals(SCREEN_H - margin, pill.bottom, 0.1f)
        // The capsule's corner arc turns about a point 28 dp in from the left edge: the display's corner centre.
        assertEquals(CORNER_DP, (pill.left + pill.height / 2f) / DENSITY, 0.3f)
        // The touch window hugs it.
        val touch = host.touch
        assertNotNull(touch)
        assertTrue("$touch should enclose $pill", touch!!.encloses(pill))
        assertTrue("$touch should stay within 6 dp of $pill", pill.inflate(dp(6f) + 1f).encloses(touch))

        val screen = renderPhone(view, frame!!, pill)

        // Pixels: a light, opaque pill body where the maths says the pill is; the darker keyboard
        // (darker still under the pill's shadow) beside, above and below it.
        val body = screen.getPixel((pill.centerX - dp(24f)).roundToInt(), pill.centerY.roundToInt())
        assertTrue("pill body should be opaque", Color.alpha(body) == 255)
        assertTrue("pill body should be light, was ${Integer.toHexString(body)}", lightness(body) > 0.9)
        assertKeyboard(screen, pill.left - dp(3f), pill.centerY)
        assertKeyboard(screen, pill.right - dp(6f), pill.bottom + dp(3f))
        assertKeyboard(screen, pill.centerX, pill.top - dp(3f))
        // The pill's left edge really is where expected: keyboard just outside, pill just inside, along its middle row.
        assertKeyboard(screen, pill.left - 2f, pill.centerY)
        assertTrue(lightness(screen.getPixel((pill.left + 2.5f).roundToInt(), pill.centerY.roundToInt())) > 0.9)

        save(screen, "pill-spot-1-galaxy-s26-ultra.png")
        save(cornerCrop(screen), "pill-spot-1-galaxy-s26-ultra-corner.png")
    }

    private fun lightness(argb: Int): Double = Oklch.fromArgb(argb).l

    /** The keyboard's own grey (lightness about 0.78), or that under the pill's shadow: never the pill's near-white body. */
    private fun assertKeyboard(screen: Bitmap, x: Float, y: Float) {
        val p = screen.getPixel(x.roundToInt(), y.roundToInt())
        assertTrue("expected keyboard at ($x, $y), was ${Integer.toHexString(p)}", lightness(p) < 0.85 && lightness(p) > 0.5)
    }

    // ---- the phone around the pill --------------------------------------------------------------

    private val SURFACE = 0xFFF6F3EE.toInt()
    private val KEYBOARD = 0xFFB4BBC6.toInt()
    private val KEY = 0xFFF8F9FB.toInt()
    private val BEZEL = 0xFF101114.toInt()
    private val INK = 0xFF3A3F47.toInt()

    /**
     * A light app surface with the keyboard's window along the bottom (its top edge where the
     * accessibility service reported it), the pill drawn by the view in screen coordinates, and the
     * display's rounded corners masked as the bezel would.
     */
    private fun renderPhone(view: OverlayPillView, canvasFrame: Box, pill: Box): Bitmap {
        val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)

        canvas.drawColor(SURFACE)
        paint.color = KEYBOARD
        canvas.drawRect(0f, keyboardTop.toFloat(), SCREEN_W.toFloat(), SCREEN_H.toFloat(), paint)
        drawKeys(canvas, paint)

        canvas.save()
        canvas.translate(canvasFrame.left, canvasFrame.top)
        view.draw(canvas)
        canvas.restore()

        // Guides: the keyboard's top edge, and the circle the display's corner turns on (the pill's
        // own end should run parallel to it).
        val guide = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = dp(1f)
            color = 0xCCE0543A.toInt()
            pathEffect = DashPathEffect(floatArrayOf(dp(4f), dp(4f)), 0f)
        }
        canvas.drawLine(0f, keyboardTop.toFloat(), SCREEN_W.toFloat(), keyboardTop.toFloat(), guide)
        guide.pathEffect = null
        canvas.drawCircle(dp(CORNER_DP), SCREEN_H - dp(CORNER_DP), dp(CORNER_DP), guide)

        maskCorners(canvas)
        drawLabels(canvas, pill)
        return bitmap
    }

    private fun drawKeys(canvas: Canvas, paint: Paint) {
        paint.color = KEY
        val rows = 4
        val keyH = dp(46f)
        val gap = dp(6f)
        val rowsTop = keyboardTop + dp(52f)
        for (row in 0 until rows) {
            val keys = when (row) { 0 -> 10; 1 -> 9; 2 -> 9; else -> 5 }
            val keyW = (SCREEN_W - gap * (keys + 1)) / keys
            for (k in 0 until keys) {
                val left = gap + k * (keyW + gap)
                val top = rowsTop + row * (keyH + gap)
                canvas.drawRoundRect(RectF(left, top, left + keyW, top + keyH), dp(6f), dp(6f), paint)
            }
        }
    }

    private fun maskCorners(canvas: Canvas) {
        val r = dp(CORNER_DP)
        val display = Path().apply {
            addRoundRect(RectF(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat()), r, r, Path.Direction.CW)
        }
        val outside = Path().apply {
            addRect(RectF(0f, 0f, SCREEN_W.toFloat(), SCREEN_H.toFloat()), Path.Direction.CW)
            op(display, Path.Op.DIFFERENCE)
        }
        canvas.drawPath(outside, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = BEZEL })
    }

    private fun drawLabels(canvas: Canvas, pill: Box) {
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = INK
            textSize = dp(12f)
        }
        canvas.drawText("Galaxy S26 Ultra · 2340 × 1080 @ 450 dpi (384 × 832 dp)", dp(16f), dp(52f), text)
        canvas.drawText("spot 1 · 11% from the left · 323 dp down over the keyboard (${KEYBOARD_DP.roundToInt()} dp tall)", dp(16f), dp(70f), text)
        canvas.drawText("keyboard top edge", dp(12f), keyboardTop - dp(6f), text)
        text.textSize = dp(11f)
        canvas.drawText("display corner, r = ${CORNER_DP.roundToInt()} dp", pill.right + dp(10f), pill.centerY - dp(4f), text)
        canvas.drawText("pill end, r = 18 dp, ${"%.1f".format(pill.left / DENSITY)} dp in, 6 dp up", pill.right + dp(10f), pill.centerY + dp(10f), text)
    }

    /** The bottom-left 240 x 130 dp of the screen, three times larger. */
    private fun cornerCrop(screen: Bitmap): Bitmap {
        val w = dp(240f).roundToInt()
        val h = dp(130f).roundToInt()
        val crop = Bitmap.createBitmap(screen, 0, SCREEN_H - h, w, h)
        return Bitmap.createBitmap(crop, 0, 0, w, h, Matrix().apply { setScale(3f, 3f) }, true)
    }

    private fun save(bitmap: Bitmap, name: String) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let(::File) ?: return
        dir.mkdirs()
        FileOutputStream(File(dir, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
