package app.murmur.android

import android.content.res.Configuration
import app.murmur.android.overlay.PillPalette
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.theme.Oklch
import app.murmur.android.ui.theme.harmonizeHue
import app.murmur.android.ui.theme.hueDelta
import app.murmur.android.ui.theme.schemeFromSeed
import app.murmur.android.ui.theme.toneToLightness
import app.murmur.android.ui.theme.withAlpha
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun `pill palette takes the scheme's brightness, accent and ink`() {
        val seed = AccentPreset.BLUE.seed
        val darkScheme = schemeFromSeed(seed, dark = true)
        val lightScheme = schemeFromSeed(seed, dark = false)
        val dark = PillTheme.fromScheme(darkScheme, dark = true)
        val light = PillTheme.fromScheme(lightScheme, dark = false)

        assertTrue(dark.isDark)
        assertFalse(light.isDark)
        // Translucent bodies: near-black at night, near-white by day, each with contrasting ink.
        assertEquals(0xF2, dark.background ushr 24)
        assertEquals(0xF2, light.background ushr 24)
        assertTrue(Oklch.fromArgb(dark.background).l < 0.3)
        assertTrue(Oklch.fromArgb(light.background).l > 0.9)
        assertTrue(Oklch.fromArgb(dark.ink).l > 0.8)
        assertTrue(Oklch.fromArgb(light.ink).l < 0.3)
        assertTrue(Oklch.fromArgb(light.inkSoft).l > Oklch.fromArgb(light.ink).l)
        assertTrue(Oklch.fromArgb(dark.inkSoft).l < Oklch.fromArgb(dark.ink).l)
        // The accent is the scheme's primary (tone 80 at night, 40 by day) and carries legible ink.
        assertEquals(darkScheme.primary, dark.accent)
        assertEquals(lightScheme.primary, light.accent)
        assertTrue(Oklch.fromArgb(dark.onAccent).l < Oklch.fromArgb(dark.accent).l - 0.3)
        assertTrue(Oklch.fromArgb(light.onAccent).l > Oklch.fromArgb(light.accent).l + 0.3)
        // The edit chrome sits in the same brightness as the body.
        assertTrue(Oklch.fromArgb(dark.panel).l < 0.3)
        assertTrue(Oklch.fromArgb(light.panel).l > 0.9)
        assertTrue(Oklch.fromArgb(dark.chip).l < 0.4)
        assertTrue(Oklch.fromArgb(light.chip).l > 0.85)
        assertTrue(Oklch.fromArgb(light.onChip).l < 0.3)
        // Status surfaces follow too and keep their hues: deep green/red with pale icons at night,
        // pale with deep icons by day.
        assertTrue(Oklch.fromArgb(dark.successBackground).l < 0.3)
        assertTrue(Oklch.fromArgb(dark.successForeground).l > 0.75)
        assertTrue(Oklch.fromArgb(light.successBackground).l > 0.85)
        assertTrue(Oklch.fromArgb(light.successForeground).l < 0.55)
        assertTrue(Oklch.fromArgb(light.errorBackground).l > 0.85)
        assertTrue(Oklch.fromArgb(light.errorForeground).l < 0.55)
        for (p in listOf(dark, light)) {
            assertTrue(Oklch.fromArgb(p.errorBackground).h in 5.0..45.0)
            assertTrue(Oklch.fromArgb(p.errorForeground).h in 5.0..45.0)
            assertTrue(Oklch.fromArgb(p.successForeground).h in 130.0..170.0)
        }
        assertEquals(0x80123456.toInt(), 0xFF123456.toInt().withAlpha(0x80))
    }

    @Test
    fun `the default pill is the dark coral one`() {
        assertEquals(PillTheme.fromScheme(schemeFromSeed(AccentPreset.CORAL.seed, dark = true), dark = true), PillPalette.DEFAULT)
        assertTrue(PillPalette.DEFAULT.isDark)
    }

    @Test
    fun `the pill is dark when the theme says so, or when the system does`() {
        val night = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES
        val day = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_NO
        assertTrue(PillTheme.isDark(ThemeMode.DARK, day))
        assertTrue(PillTheme.isDark(ThemeMode.DARK, night))
        assertFalse(PillTheme.isDark(ThemeMode.LIGHT, night))
        assertFalse(PillTheme.isDark(ThemeMode.LIGHT, day))
        assertTrue(PillTheme.isDark(ThemeMode.SYSTEM, night))
        assertFalse(PillTheme.isDark(ThemeMode.SYSTEM, day))
        assertFalse(PillTheme.isDark(ThemeMode.SYSTEM, Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_UNDEFINED))
    }
}
