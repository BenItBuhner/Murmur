package app.murmur.android

import android.content.Context
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.AccentPreset
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private const val PREFS = "murmur_settings"

/**
 * The "Button shadow" appearance setting: on by default (for installs from before it existed too),
 * kept on this device only, and carried into the pill's palette as `elevated` without changing a
 * single colour.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PillShadowSettingTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        prefs().edit().clear().commit()
    }

    private fun prefs() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Test
    fun `the shadow is on by default, on a fresh install and on one written before the setting existed`() {
        assertTrue(MurmurSettings().buttonShadow)
        assertTrue(SettingsStore(context).get().buttonShadow)
        // An older build's store: its appearance keys are all there, this one is not.
        prefs().edit()
            .putString("themeMode", ThemeMode.DARK.id)
            .putString("accent", AccentPreset.TEAL.id)
            .putBoolean("dynamicColor", false)
            .commit()
        val s = SettingsStore(context).get()
        assertTrue(s.buttonShadow)
        assertEquals(ThemeMode.DARK, s.themeMode)
        assertEquals(AccentPreset.TEAL, s.accent)
        assertFalse(s.dynamicColor)
    }

    @Test
    fun `turning it off is written to this device's store and read back`() {
        val store = SettingsStore(context)
        store.update { it.copy(buttonShadow = false) }
        assertFalse(store.get().buttonShadow)
        assertFalse(prefs().getBoolean("buttonShadow", true))
        assertFalse(SettingsStore(context).get().buttonShadow)
        store.update { it.copy(buttonShadow = true) }
        assertTrue(prefs().getBoolean("buttonShadow", false))
        assertTrue(SettingsStore(context).get().buttonShadow)
    }

    @Test
    fun `the resolved palette carries the flag and nothing else moves with it`() {
        val base = MurmurSettings(dynamicColor = false, accent = AccentPreset.CORAL, themeMode = ThemeMode.LIGHT)
        val lifted = PillTheme.resolve(context, base)
        val flat = PillTheme.resolve(context, base.copy(buttonShadow = false))
        assertTrue(lifted.elevated)
        assertFalse(flat.elevated)
        assertEquals("same colours, only the elevation differs", lifted.copy(elevated = false), flat)
        // Dark and wallpaper palettes take it the same way.
        assertFalse(PillTheme.resolve(context, MurmurSettings(themeMode = ThemeMode.DARK, buttonShadow = false)).elevated)
        assertTrue(PillTheme.resolve(context, MurmurSettings(themeMode = ThemeMode.DARK)).elevated)
        assertFalse(PillTheme.resolve(context, MurmurSettings(dynamicColor = true, buttonShadow = false)).elevated)
    }
}
