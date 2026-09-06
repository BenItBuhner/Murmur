package app.murmur.android

import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.harmonizeHue
import app.murmur.android.ui.theme.hueDelta
import app.murmur.android.ui.theme.schemeFromSeed
import app.murmur.android.ui.theme.toneToLightness
import app.murmur.android.ui.theme.withAlpha
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class ThemeTest {

    private fun channels(argb: Int) = intArrayOf((argb shr 16) and 0xFF, (argb shr 8) and 0xFF, argb and 0xFF)

    @Test
    fun `argb round-trips through oklch within a rounding step`() {
        for (argb in listOf(0xFFFF5A36, 0xFF3B82F6, 0xFF000000, 0xFFFFFFFF, 0xFF808080, 0xFF2FA84F, 0xFFEC4899)) {
            val back = Oklch.fromArgb(argb.toInt()).toArgb()
            val a = channels(argb.toInt())
            val b = channels(back)
            for (i in 0..2) assertTrue("channel $i of ${Integer.toHexString(argb.toInt())}", abs(a[i] - b[i]) <= 1)
        }
    }

    @Test
    fun `known colours land where oklch says`() {
        val white = Oklch.fromArgb(0xFFFFFFFF.toInt())
        assertEquals(1.0, white.l, 0.01)
        assertEquals(0.0, white.c, 0.0)
        val coral = Oklch.fromArgb(0xFFFF5A36.toInt())
        assertTrue(coral.l > 0.6)
        assertTrue(coral.c > 0.18)
        assertTrue(coral.h in 25.0..45.0)
        val blue = Oklch.fromArgb(0xFF3B82F6.toInt())
        assertTrue(blue.h in 240.0..275.0)
    }

    @Test
    fun `out of gamut colours lose chroma but keep their hue`() {
        val back = Oklch.fromArgb(Oklch(0.6, 0.4, 150.0).toArgb())
        assertTrue(abs(hueDelta(back.h, 150.0)) < 2.0)
        assertTrue(back.c < 0.4)
        assertTrue(back.c > 0.1)
    }

    @Test
    fun `material tones map linearly onto lightness`() {
        assertEquals(1.0, toneToLightness(100), 1e-9)
        assertEquals(56.0 / 116.0, toneToLightness(40), 1e-9)
        val grey = channels(Oklch(toneToLightness(50), 0.0, 0.0).toArgb())[0]
        assertTrue("tone 50 grey is $grey", grey in 116..124)
    }

    @Test
    fun `harmonize nudges a few degrees toward the seed`() {
        assertEquals(25.0, harmonizeHue(25.0, null), 1e-9)
        assertEquals(27.5, harmonizeHue(25.0, 30.0), 1e-9)
        assertEquals(13.0, harmonizeHue(25.0, 260.0), 1e-9)
        assertEquals(138.0, harmonizeHue(150.0, 35.0), 1e-9)
    }

    @Test
    fun `scheme from seed follows the material tone table`() {
        val seed = AccentPreset.BLUE.seed
        val light = schemeFromSeed(seed, dark = false)
        val dark = schemeFromSeed(seed, dark = true)
        val seedHue = Oklch.fromArgb(seed).h

        // Primary keeps the seed's hue in both modes; tone 40 in light, tone 80 in dark.
        for (s in listOf(light, dark)) assertTrue(abs(hueDelta(Oklch.fromArgb(s.primary).h, seedHue)) < 2.0)
        assertEquals(toneToLightness(40), Oklch.fromArgb(light.primary).l, 0.02)
        assertEquals(toneToLightness(80), Oklch.fromArgb(dark.primary).l, 0.02)
        // Text on primary contrasts with it.
        assertTrue(Oklch.fromArgb(light.onPrimary).l > Oklch.fromArgb(light.primary).l + 0.3)
        assertTrue(Oklch.fromArgb(dark.onPrimary).l < Oklch.fromArgb(dark.primary).l - 0.3)
        // Surfaces are tinted, barely: some chroma, but almost none. (Hue is not checked here: at
        // this little chroma 8-bit rounding moves it by tens of degrees; the palette itself is
        // built on the seed hue by construction.)
        val surface = Oklch.fromArgb(light.surface)
        assertTrue(surface.c > 0.003)
        assertTrue(surface.c < 0.03)
        assertTrue(surface.l > 0.95)
        assertTrue(Oklch.fromArgb(dark.surface).l < 0.25)
        // Tonal layering keeps its order.
        assertTrue(Oklch.fromArgb(dark.surfaceContainerLowest).l < Oklch.fromArgb(dark.surfaceContainer).l)
        assertTrue(Oklch.fromArgb(dark.surfaceContainer).l < Oklch.fromArgb(dark.surfaceContainerHighest).l)
        assertTrue(Oklch.fromArgb(light.surfaceContainerLowest).l > Oklch.fromArgb(light.surfaceContainer).l)
        // Tertiary sits 60 degrees round the wheel; error stays red-ish.
        assertTrue(abs(hueDelta(Oklch.fromArgb(light.tertiary).h, seedHue + 60.0)) < 3.0)
        assertTrue(Oklch.fromArgb(light.error).h in 10.0..40.0)
        assertTrue(Oklch.fromArgb(light.success).h in 130.0..165.0)
    }

    @Test
    fun `a grey seed stays grey`() {
        val scheme = schemeFromSeed(0xFF808080.toInt(), dark = false)
        assertTrue(Oklch.fromArgb(scheme.primary).c < 0.04)
    }

    @Test
    fun `every preset yields a distinct primary`() {
        val primaries = AccentPreset.entries.map { schemeFromSeed(it.seed, dark = true).primary }
        assertEquals(primaries.size, primaries.toSet().size)
    }

    @Test
    fun `pill palette keeps a translucent dark body and an accent that matches the seed`() {
        val palette = PillTheme.fromAccent(0xFF7CACF8.toInt(), 0xFF1B1B1F.toInt())
        assertEquals(0xF2, (palette.background ushr 24))
        assertEquals(0xFF7CACF8.toInt(), palette.accent)
        assertTrue(Oklch.fromArgb(palette.successBackground).l < 0.3)
        assertTrue(Oklch.fromArgb(palette.successForeground).l > 0.75)
        assertTrue(Oklch.fromArgb(palette.errorBackground).h in 5.0..45.0)
        assertEquals(0x80123456.toInt(), 0xFF123456.toInt().withAlpha(0x80))
    }
}
