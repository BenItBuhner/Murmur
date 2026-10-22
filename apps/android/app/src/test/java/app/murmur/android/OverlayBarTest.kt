package app.murmur.android

import app.murmur.android.overlay.BarAnchor
import app.murmur.android.overlay.BarEdge
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayBar
import app.murmur.android.overlay.OverlayBarPlacement
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.KeyboardSettingsCodec
import app.murmur.android.settings.OverlayPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The desktop-style bar's size and placement. The phone's spots are a different thing. */
class OverlayBarTest {

    @Test
    fun `a stored keyboard section from before the bar could move stays centered at the default size`() {
        val decoded = KeyboardSettingsCodec.decode("""{"overlayPosition":"top-center","showOverlayWhenIdle":false}""")
        assertEquals(OverlayPosition.TOP_CENTER, decoded.overlayPosition)
        assertEquals(OverlayBar.DEFAULT, decoded.overlayBar)
        assertEquals(BarAnchor.PRESET, decoded.overlayBar.anchor)
        assertEquals(56f, decoded.overlayBar.widthDp)
        assertEquals(6f, decoded.overlayBar.heightDp)
    }

    @Test
    fun `a free placement and a custom size survive a round trip and a bad value is clamped`() {
        val stored = KeyboardSettings(
            overlayBar = OverlayBar(BarAnchor.FREE, x = 0.2f, y = 0.8f, widthDp = 120f, heightDp = 14f)
        )
        val decoded = KeyboardSettingsCodec.decode(KeyboardSettingsCodec.encode(stored))
        assertEquals(BarAnchor.FREE, decoded.overlayBar.anchor)
        assertEquals(0.2f, decoded.overlayBar.x)
        assertEquals(0.8f, decoded.overlayBar.y)
        assertEquals(120f, decoded.overlayBar.widthDp)
        assertEquals(14f, decoded.overlayBar.heightDp)

        val wild = KeyboardSettingsCodec.decode(
            """{"overlayBarAnchor":"free","overlayBarX":4,"overlayBarY":-1,"overlayBarWidth":900,"overlayBarHeight":0}"""
        )
        assertEquals(BarAnchor.FREE, wild.overlayBar.anchor)
        assertEquals(1f, wild.overlayBar.x)
        assertEquals(0f, wild.overlayBar.y)
        assertEquals(OverlayBar.MAX_WIDTH_DP, wild.overlayBar.widthDp)
        assertEquals(OverlayBar.MIN_HEIGHT_DP, wild.overlayBar.heightDp)
    }

    @Test
    fun `the bar body moves and the ring around it resizes, and a point off center does not snap`() {
        val bar = Box(100f, 200f, 156f, 206f)
        assertEquals(BarEdge.BODY, OverlayBarPlacement.edgeAt(bar, 120f, 203f, 8f))
        assertEquals(BarEdge.N, OverlayBarPlacement.edgeAt(bar, 120f, 196f, 8f))
        assertEquals(BarEdge.W, OverlayBarPlacement.edgeAt(bar, 96f, 203f, 8f))
        assertEquals(BarEdge.SE, OverlayBarPlacement.edgeAt(bar, 160f, 210f, 8f))
        assertNull(OverlayBarPlacement.edgeAt(bar, 40f, 203f, 8f))

        val taller = OverlayBarPlacement.resize(BarEdge.N, 56f, 6f, 0f, -10f)
        assertEquals(56f, taller.widthDp)
        assertEquals(16f, taller.heightDp)
        val wider = OverlayBarPlacement.resize(BarEdge.E, 56f, 6f, 40f, 0f)
        assertEquals(96f, wider.widthDp)
        val capped = OverlayBarPlacement.resize(BarEdge.S, 56f, 6f, 0f, 100f)
        assertEquals(OverlayBar.MAX_HEIGHT_DP, capped.heightDp)

        val presets = listOf(
            OverlayPosition.BOTTOM_CENTER to (540f to 2200f),
            OverlayPosition.TOP_CENTER to (540f to 80f),
            OverlayPosition.BOTTOM_RIGHT to (900f to 2200f)
        )
        assertEquals(
            OverlayPosition.BOTTOM_CENTER,
            OverlayBarPlacement.nearestPreset(540f, 2210f, presets, snapPx = 24f)
        )
        assertNull(OverlayBarPlacement.nearestPreset(200f, 400f, presets, snapPx = 24f))
        // A free spot in the top third grows downward; one lower down grows upward, like the bottom bar.
        assertTrue(OverlayBarPlacement.lookCenterY(100f, 18f, 120f, 2400f) > 100f)
        assertTrue(OverlayBarPlacement.lookCenterY(2000f, 18f, 120f, 2400f) < 2000f)
    }
}
