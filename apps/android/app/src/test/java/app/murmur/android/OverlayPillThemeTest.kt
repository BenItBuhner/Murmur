package app.murmur.android

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import app.murmur.android.dictation.DictationState
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillPalette
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.OverlayShape
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.schemeFromSeed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val DENSITY = 3f
private const val VIEW_W = (300 * DENSITY).toInt()
private const val VIEW_H = (100 * DENSITY).toInt()

/** The resting pill (OverlayPillView's idle look for OverlayShape.PILL) at xxhdpi. */
private const val PILL_W = 64 * DENSITY
private const val PILL_H = 36 * DENSITY

/**
 * The pill wears the theme: a light body with dark ink over a light keyboard, the reverse over a
 * dark one, and the palette comes from the same appearance settings as the app's screens. These
 * render the real view (as the settings preview does) and look at the pixels.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillThemeTest {

    private fun palette(dark: Boolean, accent: AccentPreset = AccentPreset.CORAL): PillPalette =
        PillTheme.fromScheme(schemeFromSeed(accent.seed, dark), dark)

    /** A hostless pill, as in the settings preview: its own bounds are the screen and it rests in the middle. */
    private fun pill(palette: PillPalette): OverlayPillView {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        return OverlayPillView(activity).apply {
            previewMode = true
            setPalette(palette)
            configure(OverlayShape.PILL, OverlayLayout.DEFAULT)
            measure(
                View.MeasureSpec.makeMeasureSpec(VIEW_W, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(VIEW_H, View.MeasureSpec.EXACTLY)
            )
            layout(0, 0, VIEW_W, VIEW_H)
            render(DictationState.Idle)
        }
    }

    private fun draw(view: OverlayPillView): Bitmap {
        val bitmap = Bitmap.createBitmap(VIEW_W, VIEW_H, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        return bitmap
    }

    private fun lightness(argb: Int): Double = Oklch.fromArgb(argb).l

    /** The body, a little left of the mic icon (which spans about 7 dp either side of the centre). */
    private fun bodyPixel(bitmap: Bitmap): Int = bitmap.getPixel(VIEW_W / 2 - (24 * DENSITY).toInt(), VIEW_H / 2)

    /** Lightness of the darkest and lightest opaque pixels inside the resting pill's box. */
    private fun inkRange(bitmap: Bitmap): Pair<Double, Double> {
        var min = 1.0
        var max = 0.0
        val left = (VIEW_W / 2 - PILL_W / 2 + 2 * DENSITY).toInt()
        val right = (VIEW_W / 2 + PILL_W / 2 - 2 * DENSITY).toInt()
        val top = (VIEW_H / 2 - PILL_H / 2 + 2 * DENSITY).toInt()
        val bottom = (VIEW_H / 2 + PILL_H / 2 - 2 * DENSITY).toInt()
        for (y in top..bottom) for (x in left..right) {
            val p = bitmap.getPixel(x, y)
            if (Color.alpha(p) < 230) continue
            val l = lightness(p)
            if (l < min) min = l
            if (l > max) max = l
        }
        return min to max
    }

    @Test
    fun `a light palette draws a light body with dark ink`() {
        val bitmap = draw(pill(palette(dark = false)))
        val body = bodyPixel(bitmap)
        assertTrue("body should be opaque", Color.alpha(body) >= 230)
        assertTrue("body should be light, was ${Integer.toHexString(body)}", lightness(body) > 0.9)
        val (darkest, _) = inkRange(bitmap)
        assertTrue("the mic outline should be dark ink, darkest was $darkest", darkest < 0.35)
    }

    @Test
    fun `a dark palette draws a dark body with light ink`() {
        val bitmap = draw(pill(palette(dark = true)))
        val body = bodyPixel(bitmap)
        assertTrue("body should be opaque", Color.alpha(body) >= 230)
        assertTrue("body should be dark, was ${Integer.toHexString(body)}", lightness(body) < 0.3)
        val (_, lightest) = inkRange(bitmap)
        assertTrue("the mic outline should be light ink, lightest was $lightest", lightest > 0.75)
    }

    @Test
    fun `flipping the palette repaints the body in the new brightness`() {
        val view = pill(palette(dark = true))
        assertTrue(lightness(bodyPixel(draw(view))) < 0.3)
        view.setPalette(palette(dark = false, accent = AccentPreset.BLUE))
        // A brightness flip snaps rather than morphing, so the very next frame is already light.
        assertTrue(lightness(bodyPixel(draw(view))) > 0.9)
        view.setPalette(palette(dark = true, accent = AccentPreset.BLUE))
        assertTrue(lightness(bodyPixel(draw(view))) < 0.3)
    }

    @Test
    fun `the resolved palette follows the theme mode, and the system when asked to`() {
        val context = RuntimeEnvironment.getApplication()
        val base = MurmurSettings(dynamicColor = false, accent = AccentPreset.TEAL)
        val light = schemeFromSeed(AccentPreset.TEAL.seed, dark = false)
        val dark = schemeFromSeed(AccentPreset.TEAL.seed, dark = true)

        assertFalse(PillTheme.resolve(context, base.copy(themeMode = ThemeMode.LIGHT)).isDark)
        assertEquals(light.primary, PillTheme.resolve(context, base.copy(themeMode = ThemeMode.LIGHT)).accent)
        assertTrue(PillTheme.resolve(context, base.copy(themeMode = ThemeMode.DARK)).isDark)
        assertEquals(dark.primary, PillTheme.resolve(context, base.copy(themeMode = ThemeMode.DARK)).accent)

        assertFalse(PillTheme.resolve(context, base.copy(themeMode = ThemeMode.SYSTEM)).isDark)
        RuntimeEnvironment.setQualifiers("+night")
        assertEquals(
            Configuration.UI_MODE_NIGHT_YES,
            context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        )
        assertTrue(PillTheme.resolve(context, base.copy(themeMode = ThemeMode.SYSTEM)).isDark)
        assertFalse(PillTheme.resolve(context, base.copy(themeMode = ThemeMode.LIGHT)).isDark)
    }

    @Test
    fun `wallpaper colours resolve in both brightnesses on Android 12 and later`() {
        val context = RuntimeEnvironment.getApplication()
        val settings = MurmurSettings(dynamicColor = true)
        val light = PillTheme.resolve(context, settings.copy(themeMode = ThemeMode.LIGHT))
        val dark = PillTheme.resolve(context, settings.copy(themeMode = ThemeMode.DARK))
        assertFalse(light.isDark)
        assertTrue(dark.isDark)
        assertTrue(lightness(light.background) > 0.85)
        assertTrue(lightness(dark.background) < 0.35)
        assertTrue(lightness(light.ink) < 0.35)
        assertTrue(lightness(dark.ink) > 0.75)
        // Material You accents: tone 40 by day, tone 80 at night.
        assertTrue(lightness(light.accent) < lightness(dark.accent))
    }
}
