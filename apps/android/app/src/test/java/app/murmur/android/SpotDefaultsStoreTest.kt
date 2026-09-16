package app.murmur.android

import android.content.Context
import app.murmur.android.overlay.DeviceDisplay
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayArrangement
import app.murmur.android.overlay.OverlayDefaults
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayLayoutCodec
import app.murmur.android.settings.SettingsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBuild

private const val PREFS = "murmur_settings"

/**
 * The store hands every install its device's own spots: the hand-tuned pair on a Galaxy S26 Ultra,
 * a pair derived from the display everywhere else. Only untouched spots are replaced; edited ones
 * stay, and Reset comes back to the device's default. Runs on a 384 x 832 dp display (a Galaxy
 * S26 Ultra's, at its out-of-the-box 2340 x 1080 rendering).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w384dp-h832dp-450dpi")
class SpotDefaultsStoreTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun seedLayout(layout: OverlayLayout) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("overlayLayout", OverlayLayoutCodec.encode(layout))
            .commit()
    }

    @Test
    fun `the display is measured upright in dp`() {
        val geometry = DeviceDisplay.geometry(context)
        assertEquals(384f, geometry.widthDp, 0.5f)
        assertEquals(832f, geometry.heightDp, 0.5f)
        assertTrue(geometry.cornerRadiusDp >= 0f)
        assertEquals(android.os.Build.MODEL, geometry.model)
    }

    @Test
    fun `a Galaxy S26 Ultra starts on the hand-tuned spots`() {
        ShadowBuild.setModel("SM-S948B/DS")
        val store = SettingsStore(context)
        assertSame(OverlayLayout.DEFAULT, store.defaultOverlayLayout)
        assertEquals(OverlayLayout.DEFAULT, store.get().overlayLayout)
        assertEquals("11% from the left, 323 dp down over the keyboard", store.get().overlayLayout.active.describe())
    }

    @Test
    fun `any other phone starts on spots derived from its display`() {
        ShadowBuild.setModel("Pixel 9")
        val store = SettingsStore(context)
        val expected = OverlayDefaults.derive(DeviceDisplay.geometry(context))
        assertNotEquals(OverlayLayout.DEFAULT, store.defaultOverlayLayout)
        assertEquals(expected, store.defaultOverlayLayout)
        assertEquals(expected, store.get().overlayLayout)
        // The corner spot, then the middle 25 dp above the keyboard; the button starts in the corner.
        assertEquals(0, expected.activeIndex)
        assertEquals(OverlayAnchor(0.5f, 25f), expected.spots[1])
        assertTrue(expected.spots[0].xFraction < 0.15f)
        assertTrue(expected.spots[0].offsetDp < -700f)
    }

    @Test
    fun `an install still on the old default gets the new one, whichever spot it rested on`() {
        ShadowBuild.setModel("Pixel 9")
        seedLayout(OverlayLayout.LEGACY_DEFAULT)
        val store = SettingsStore(context)
        assertEquals(store.defaultOverlayLayout, store.get().overlayLayout)

        seedLayout(OverlayLayout.LEGACY_DEFAULT.activated(1))
        assertEquals(store.defaultOverlayLayout, SettingsStore(context).get().overlayLayout)
    }

    @Test
    fun `edited spots are kept`() {
        ShadowBuild.setModel("SM-S948U")
        val edited = OverlayLayout(
            listOf(OverlayAnchor(0.5f, 30f), OverlayAnchor(0.92f, -18f), OverlayAnchor(0.08f, -18f)),
            activeIndex = 2,
            arrangement = OverlayArrangement.SAME_ROW
        )
        seedLayout(edited)
        assertEquals(edited, SettingsStore(context).get().overlayLayout)
        // Even an edit that only moved one of the old spots a little.
        val nudged = OverlayLayout.LEGACY_DEFAULT.moved(1, OverlayAnchor(1f, 31f))
        seedLayout(nudged)
        assertEquals(nudged, SettingsStore(context).get().overlayLayout)
    }

    @Test
    fun `a single position from before spots is kept as the active spot, its default is not`() {
        ShadowBuild.setModel("Pixel 9")
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putFloat("overlayAnchorX", 0.9f).putFloat("overlayOffsetDp", -20f).commit()
        val kept = SettingsStore(context).get().overlayLayout
        assertEquals(OverlayAnchor(0.9f, -20f), kept.active)

        prefs.edit().clear().putFloat("overlayAnchorX", 0.5f).putFloat("overlayOffsetDp", 30f).commit()
        val store = SettingsStore(context)
        assertEquals(store.defaultOverlayLayout, store.get().overlayLayout)
    }

    @Test
    fun `reset returns to the device's default and survives a restart`() {
        ShadowBuild.setModel("Pixel 9")
        val store = SettingsStore(context)
        val default = store.defaultOverlayLayout
        store.update { it.copy(overlayLayout = it.overlayLayout.moved(0, OverlayAnchor(0.3f, 60f))) }
        assertNotEquals(default, store.get().overlayLayout)
        store.update { it.copy(overlayLayout = store.defaultOverlayLayout) }
        assertEquals(default, store.get().overlayLayout)
        assertEquals(default, SettingsStore(context).get().overlayLayout)
    }
}
