package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.inference.LimitNotice
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillPalette
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.OverlayShape
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.schemeFromSeed
import org.junit.Assert.assertEquals
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
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

/** Galaxy S26 Ultra at its out-of-the-box rendering (as OverlayPillSpotScreenshotTest): 384 x 832 dp at 2.8125 px/dp. */
private const val DENSITY = 2.8125f
private const val SCREEN_W = 1080
private const val SCREEN_H = 2340

/** A 347 dp keyboard: a toolbar strip (suggestions, no keys) and then four rows of keys. */
private const val KEYBOARD_DP = 347f
private const val STRIP_DP = 52f

private const val FRAME_MS = 16L
private const val TOUCH_PAD_DP = 6f

/**
 * The "Button shadow" setting on the pill itself. With it on, the pill casts its drop shadow onto
 * the keyboard and wears a light catch along its top edge; with it off, the very same pill (same
 * outline, same colours, same contents) is drawn flat and leaves every pixel around it exactly as
 * the keyboard had it. Checked in every state the pill takes, on the edit panel, and when the
 * setting flips under a pill that is already showing. The frames are written out as PNGs (under
 * build/reports/pill-screenshots) so the two can be seen side by side.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
class OverlayPillShadowScreenshotTest {

    private class RecordingHost : OverlayPillView.Host {
        var canvas: Box = Box.EMPTY
        var touch: Box = Box.EMPTY
        override fun applyCanvasFrame(frame: Box) { canvas = frame }
        override fun applyTouchFrame(frame: Box) { touch = frame }
    }

    private class Rendered(val view: OverlayPillView, val host: RecordingHost, val screen: Bitmap) {
        /** The pill's outline, from the touch window that hugs it (not in edit mode, where that window is the screen). */
        val pill: Box get() = host.touch.inflate(-TOUCH_PAD_DP * DENSITY)
    }

    private fun dp(v: Float): Float = v * DENSITY
    private val keyboardTop = (SCREEN_H - dp(KEYBOARD_DP)).roundToInt()

    /** One spot 60 dp down into the keyboard: the pill's top edge lies on the toolbar strip, its shadow falls on the first key rows. */
    private val overKeyboard = OverlayLayout(listOf(OverlayAnchor(0.5f, -60f)))

    private val limit = LimitNotice(
        limit = "wordsPerWeek", plan = "free", planState = "free", used = 503.0, allowed = 500.0,
        resetsAt = System.currentTimeMillis() + 2 * 86_400_000L, upgradeUrl = "https://murmur.app/account?upgrade=yearly",
        accountUrl = "https://murmur.app/account", message = "This week's 500 free words are used up."
    )

    private fun palette(elevated: Boolean, dark: Boolean = false): PillPalette =
        PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark), dark, elevated = elevated)

    /** The real view, hosted as the accessibility service hosts it, drawn over the keyboard after everything has settled. */
    private fun render(state: DictationState, palette: PillPalette, layout: OverlayLayout = overKeyboard, editing: Boolean = false): Rendered {
        val host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val view = OverlayPillView(activity).apply { this.host = host }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        assertEquals(DENSITY, view.resources.displayMetrics.density, 0.0001f)
        view.setPalette(palette)
        view.configure(OverlayShape.PILL, layout)
        view.setScreen(SCREEN_W, SCREEN_H, keyboardTop)
        view.setEditing(editing)
        view.render(state)
        val rendered = Rendered(view, host, Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888))
        settle(rendered)
        return rendered
    }

    /** Frames until the tick has drawn itself in and the waveform has filled, then the frame that is kept. */
    private fun settle(r: Rendered) {
        val scratch = Canvas(Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888))
        repeat(40) {
            r.view.draw(scratch)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
        frame(r)
    }

    /** The keyboard, then the view drawn where its canvas window sits, into [Rendered.screen]. */
    private fun frame(r: Rendered) {
        val canvas = Canvas(r.screen)
        drawBackdrop(canvas)
        canvas.save()
        canvas.translate(r.host.canvas.left, r.host.canvas.top)
        r.view.draw(canvas)
        canvas.restore()
    }

    // ---- what the setting must and must not change --------------------------------------------

    /**
     * The same state with the shadow on and off: identical outline, and a body that is exactly the
     * palette's colour for the state, opaque, in both; the flat one leaves the keyboard under and
     * beside it untouched and has no light catch; the lifted one shades the keys below it and wears
     * the catch. Returns the pair for the screenshots.
     */
    private fun check(name: String, state: DictationState, heightDp: Float, dark: Boolean = false): Pair<Rendered, Rendered> {
        val lifted = render(state, palette(elevated = true, dark = dark))
        val flat = render(state, palette(elevated = false, dark = dark))
        val pill = flat.pill
        assertEquals("$name: same outline", lifted.pill, pill)
        assertEquals("$name: the look's height", heightDp, pill.height / DENSITY, 0.01f)

        // Under the pill (2 to 7 dp below its bottom edge, clear of its rounded ends).
        val below = Box(pill.left + dp(8f), pill.bottom + dp(2f), pill.right - dp(8f), pill.bottom + dp(7f))
        assertUntouched(flat.screen, below, "$name flat: under the pill")
        assertShaded(lifted.screen, flat.screen, below, "$name lifted: under the pill")
        // Beside it, along the middle of its right end (the blur reaches sideways too, but it is
        // offset downwards and fades out around the capsule's lower curve).
        val beside = Box(pill.right + dp(2f), pill.top + pill.height * 0.3f, pill.right + dp(4f), pill.top + pill.height * 0.7f)
        assertUntouched(flat.screen, beside, "$name flat: beside the pill")
        assertShaded(lifted.screen, flat.screen, beside, "$name lifted: beside the pill")

        // The light catch: the 1 dp along the top edge, on the straight part of the outline, over the keyboard's plain strip.
        val x = (pill.left + dp(30f)).roundToInt()
        val catchY = floor(pill.top + dp(0.5f)).toInt()
        val bodyY = floor(pill.top + dp(3f)).toInt()
        val body = flat.screen.getPixel(x, bodyY)
        // The body is the palette's colour for this state, to the bit, in both renders: the surface
        // is fully opaque, so neither the keyboard nor the pill's own shadow shows through it.
        val expectedBody = bodyColourOf(state, palette(elevated = false, dark = dark))
        assertEquals("$name flat: the body is the pill colour ${hex(expectedBody)}", hex(expectedBody), hex(body))
        assertEquals("$name lifted: the body is the pill colour ${hex(expectedBody)}", hex(expectedBody), hex(lifted.screen.getPixel(x, bodyY)))
        assertEquals("$name: an opaque body", 0xFF, body ushr 24)
        assertEquals("$name flat: no light catch", body, flat.screen.getPixel(x, catchY))
        val catchDelta = lightness(lifted.screen.getPixel(x, catchY)) - lightness(body)
        assertTrue("$name lifted: a light catch on the top edge ($catchDelta)", abs(catchDelta) > 0.01)
        // Dark ink by day, light ink by night: the catch is a shade of the ink.
        if (dark) assertTrue(catchDelta > 0) else assertTrue(catchDelta < 0)
        return lifted to flat
    }

    @Test
    fun `idle button`() {
        val (lifted, flat) = check("idle", DictationState.Idle, 36f)
        save(lifted, "android-idle-shadow-on.png")
        save(flat, "android-idle-shadow-off.png")
    }

    @Test
    fun `listening`() {
        val (lifted, flat) = check("listening", DictationState.Listening(elapsedSec = 4, level = 0.6f), 46f)
        save(lifted, "android-listening-shadow-on.png")
        save(flat, "android-listening-shadow-off.png")
    }

    @Test
    fun `transcribing`() {
        val (lifted, flat) = check("transcribing", DictationState.Processing("Transcribing…"), 46f)
        save(lifted, "android-transcribing-shadow-on.png")
        save(flat, "android-transcribing-shadow-off.png")
    }

    @Test
    fun `success, plain and with the soft limit line`() {
        val (lifted, flat) = check("success", DictationState.Success("Inserted"), 46f)
        save(lifted, "android-success-shadow-on.png")
        save(flat, "android-success-shadow-off.png")
        check("soft-limit", DictationState.Success("Inserted, formatting paused", limit = limit), 64f)
    }

    @Test
    fun `error with Retry`() {
        val (lifted, flat) = check("error", DictationState.Error("The server took too long to respond", retryId = "entry-1"), 46f)
        save(lifted, "android-error-shadow-on.png")
        save(flat, "android-error-shadow-off.png")
        check("error-plain", DictationState.Error("Microphone unavailable"), 46f)
    }

    @Test
    fun `limit notice`() {
        val (lifted, flat) = check("limit", DictationState.Error(limit.message, retryId = "entry-1", limit = limit), 104f)
        save(lifted, "android-limit-shadow-on.png")
        save(flat, "android-limit-shadow-off.png")
    }

    @Test
    fun `the dark pill goes flat the same way`() {
        check("idle-dark", DictationState.Idle, 36f, dark = true)
        check("listening-dark", DictationState.Listening(elapsedSec = 1, level = 0.5f), 46f, dark = true)
    }

    @Test
    fun `the edit panel and its chips go flat with the pill`() {
        val lifted = render(DictationState.Idle, palette(elevated = true), layout = OverlayLayout.DEFAULT, editing = true)
        val flat = render(DictationState.Idle, palette(elevated = false), layout = OverlayLayout.DEFAULT, editing = true)
        // The panel is the first thing under the status bar in the middle column; it ends where the app surface shows again.
        val backdrop = backdrop()
        val x = SCREEN_W / 2
        var y = dp(8f).roundToInt()
        while (flat.screen.getPixel(x, y) == backdrop.getPixel(x, y)) y++
        val panelTop = y
        while (flat.screen.getPixel(x, y) != backdrop.getPixel(x, y)) y++
        val panelBottom = y
        assertTrue("a panel of three rows and a caption, from $panelTop to $panelBottom", panelBottom - panelTop > dp(120f))
        assertTrue("the same panel in both", lifted.screen.getPixel(x, panelTop) != backdrop.getPixel(x, panelTop))

        val below = Box(dp(40f), panelBottom + dp(2f), SCREEN_W - dp(40f), panelBottom + dp(8f))
        assertUntouched(flat.screen, below, "flat edit panel: under it")
        assertShaded(lifted.screen, flat.screen, below, "lifted edit panel: under it")
        // A chip inside the panel: Done sits at the right end of the first row (12 dp padding, 34 dp tall) and its
        // shadow falls on the panel below it. Flat, the gap under it is plain panel, the same as the panel's own
        // padding above the row; lifted, it is shaded.
        val chipBottom = panelTop + dp(12f) + dp(34f)
        val gapY = (chipBottom + dp(3f)).roundToInt()
        val paddingY = (panelTop + dp(6f)).roundToInt()
        val underDone = (SCREEN_W - dp(12f) - dp(12f) - dp(20f)).roundToInt()
        assertEquals("flat: no chip shadow on the panel", flat.screen.getPixel(underDone, paddingY), flat.screen.getPixel(underDone, gapY))
        // The panel and the chips on it are their palette colours to the bit, lifted or flat: opaque surfaces.
        val flatPalette = palette(elevated = false)
        assertEquals("flat: the panel is its colour", hex(flatPalette.panel), hex(flat.screen.getPixel(underDone, paddingY)))
        assertEquals("lifted: the panel is its colour", hex(flatPalette.panel), hex(lifted.screen.getPixel(underDone, paddingY)))
        val inDone = (panelTop + dp(12f) + dp(4f)).roundToInt()
        assertEquals("flat: the Done chip is its colour", hex(flatPalette.accent), hex(flat.screen.getPixel(underDone, inDone)))
        assertEquals("lifted: the Done chip is its colour", hex(flatPalette.accent), hex(lifted.screen.getPixel(underDone, inDone)))
        assertTrue(
            "lifted: the Done chip shades the panel under it",
            lightness(lifted.screen.getPixel(underDone, gapY)) < lightness(flat.screen.getPixel(underDone, gapY)) - 0.005
        )

        save(lifted, "android-edit-panel-shadow-on.png", crop = false)
        save(flat, "android-edit-panel-shadow-off.png", crop = false)
    }

    @Test
    fun `every surface in the palette is opaque, lifted or flat, by day and by night`() {
        for (dark in listOf(false, true)) for (elevated in listOf(true, false)) {
            val p = palette(elevated, dark)
            for ((name, colour) in listOf(
                "background" to p.background, "panel" to p.panel, "chip" to p.chip, "accent" to p.accent,
                "successBackground" to p.successBackground, "errorBackground" to p.errorBackground
            )) {
                assertEquals("$name (dark=$dark, elevated=$elevated) is opaque: ${hex(colour)}", 0xFF, colour ushr 24)
            }
        }
    }

    @Test
    fun `flipping the setting repaints the pill that is already showing, in place`() {
        val r = render(DictationState.Idle, palette(elevated = true))
        val pill = r.pill
        val below = Box(pill.left + dp(8f), pill.bottom + dp(2f), pill.right - dp(8f), pill.bottom + dp(7f))
        val shaded = Bitmap.createBitmap(r.screen)
        // The accessibility service hands the pill a new palette when the setting changes; nothing else is touched.
        r.view.setPalette(palette(elevated = false))
        ShadowLooper.idleMainLooper()
        frame(r)
        assertEquals("still the same pill", pill, r.pill)
        assertUntouched(r.screen, below, "after turning the shadow off")
        assertShaded(shaded, r.screen, below, "before, against after")
        r.view.setPalette(palette(elevated = true))
        ShadowLooper.idleMainLooper()
        frame(r)
        assertShaded(r.screen, backdrop(), below, "after turning it back on")
    }

    // ---- pixel assertions -----------------------------------------------------------------------

    private fun lightness(argb: Int): Double = Oklch.fromArgb(argb).l

    /** The surface the view paints the body with for [state]: success and error tints, otherwise the pill's own. */
    private fun bodyColourOf(state: DictationState, palette: PillPalette): Int = when {
        state is DictationState.Success -> palette.successBackground
        state is DictationState.Error && state.limit == null -> palette.errorBackground
        else -> palette.background
    }

    /** Every pixel of [box] in [screen] is the backdrop's own: nothing was drawn or shaded there. */
    private fun assertUntouched(screen: Bitmap, box: Box, what: String) {
        val backdrop = backdrop()
        for (y in box.top.roundToInt()..box.bottom.roundToInt()) for (x in box.left.roundToInt()..box.right.roundToInt()) {
            val expected = backdrop.getPixel(x, y)
            val actual = screen.getPixel(x, y)
            assertEquals("$what at ($x, $y): expected the backdrop's ${hex(expected)}, was ${hex(actual)}", expected, actual)
        }
    }

    /** Over [box], [shaded] is nowhere lighter than [plain] and darker over most of it: a shadow fell there. */
    private fun assertShaded(shaded: Bitmap, plain: Bitmap, box: Box, what: String) {
        var darker = 0
        var total = 0
        for (y in box.top.roundToInt()..box.bottom.roundToInt()) for (x in box.left.roundToInt()..box.right.roundToInt()) {
            val s = lightness(shaded.getPixel(x, y))
            val p = lightness(plain.getPixel(x, y))
            assertTrue("$what at ($x, $y): lighter than without a shadow", s <= p + 0.002)
            total++
            if (s < p - 0.004) darker++
        }
        assertTrue("$what: only $darker of $total pixels are darker", darker > total * 0.8)
    }

    private fun hex(argb: Int): String = "#%08X".format(argb)

    // ---- the phone around the pill --------------------------------------------------------------

    private val SURFACE = 0xFFF6F3EE.toInt()
    private val KEYBOARD = 0xFFB4BBC6.toInt()
    private val KEY = 0xFFF8F9FB.toInt()

    private var backdropCache: Bitmap? = null

    private fun backdrop(): Bitmap = backdropCache ?: Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888).also {
        drawBackdrop(Canvas(it))
        backdropCache = it
    }

    /** A light app surface with a light keyboard along the bottom: its toolbar strip, then rows of keys. */
    private fun drawBackdrop(canvas: Canvas) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawColor(SURFACE)
        paint.color = KEYBOARD
        canvas.drawRect(0f, keyboardTop.toFloat(), SCREEN_W.toFloat(), SCREEN_H.toFloat(), paint)
        paint.color = KEY
        val keyH = dp(46f)
        val gap = dp(6f)
        val rowsTop = keyboardTop + dp(STRIP_DP)
        for (row in 0 until 4) {
            val keys = when (row) { 0 -> 10; 1 -> 9; 2 -> 9; else -> 5 }
            val keyW = (SCREEN_W - gap * (keys + 1)) / keys
            for (k in 0 until keys) {
                val left = gap + k * (keyW + gap)
                val top = rowsTop + row * (keyH + gap)
                canvas.drawRoundRect(RectF(left, top, left + keyW, top + keyH), dp(6f), dp(6f), paint)
            }
        }
    }

    /** The keyboard region (24 dp above its top edge to the bottom of the screen), or the whole screen. */
    private fun save(r: Rendered, name: String, crop: Boolean = true) {
        val dir = System.getProperty("murmur.screenshotDir")?.takeIf { it.isNotBlank() }?.let(::File) ?: return
        dir.mkdirs()
        val top = if (crop) (keyboardTop - dp(24f)).roundToInt() else 0
        val bitmap = Bitmap.createBitmap(r.screen, 0, top, SCREEN_W, SCREEN_H - top)
        FileOutputStream(File(dir, name)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
