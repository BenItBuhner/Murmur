package app.murmur.android.overlay

import kotlin.math.max
import kotlin.math.roundToInt

/**
 * What the default spots are derived from, in dp (portrait, whatever way the phone is held) so the
 * rule reads the same at every rendering resolution a phone offers. Plain Kotlin; [DeviceDisplay]
 * measures a real device.
 */
data class DisplayGeometry(
    val widthDp: Float,
    val heightDp: Float,
    /** Radius of the display's bottom-left rounded corner; 0 for a square corner, or when the device does not say. */
    val cornerRadiusDp: Float,
    /** `Build.MODEL`, e.g. "SM-S948B"; matched by prefix against the devices tuned by hand. */
    val model: String
)

/**
 * The spots a device starts with. Two of them, everywhere: the bottom-left corner of the screen,
 * and the middle of the screen just above the keyboard. A model that has been tuned by hand gets
 * the exact spots it was tuned to ([pinnedFor]); every other display derives the same two spots
 * from its own geometry ([derive]). Existing installs only pick these up while their spots are
 * untouched (see OverlayLayout.isUntouchedLegacyDefault); Reset comes back here.
 */
object OverlayDefaults {
    /** Spot 2: the resting button's centre this far above the keyboard's top edge. */
    const val ABOVE_KEYBOARD_DP = 25f

    /** A model tuned by hand: `Build.MODEL` prefix (case-insensitive) and the spots that were tuned on it. */
    data class Pin(val modelPrefix: String, val device: String, val layout: OverlayLayout)

    /**
     * Devices tuned by hand. Galaxy S26 Ultra: SM-S948B, SM-S948B/DS, SM-S948U, SM-S948U1, SM-S948W,
     * SM-S948N, SM-S9480, SM-S948E, SM-S948E/DS, all under one prefix. Its display is 1440 x 3120 at
     * 498 ppi, rendered at 384 x 832 dp (2340 x 1080 at 450 dpi out of the box, or 3120 x 1440 at
     * 600 dpi); the geometry rule cannot land on its 323 dp, which encodes the height of the keyboard
     * it was tuned with (347 dp: 323 = 347 - 6 margin - 18 half a button), so the pin wins there.
     */
    val PINS: List<Pin> = listOf(
        Pin("SM-S948", "Galaxy S26 Ultra", OverlayLayout.DEFAULT)
    )

    /** The spots for this device: its pin when it has one, otherwise derived from its display. */
    fun layoutFor(geometry: DisplayGeometry): OverlayLayout =
        pinnedFor(geometry.model) ?: derive(geometry)

    /** The hand-tuned spots for [model] (a `Build.MODEL`), or null when it is not a model that was tuned. */
    fun pinnedFor(model: String?): OverlayLayout? {
        val name = model?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return PINS.firstOrNull { name.startsWith(it.modelPrefix, ignoreCase = true) }?.layout
    }

    /**
     * The two spots laid out on this display: [cornerSpot] and the middle of the screen
     * [ABOVE_KEYBOARD_DP] above the keyboard. The button starts in the corner.
     */
    fun derive(geometry: DisplayGeometry): OverlayLayout {
        if (geometry.widthDp <= 0f || geometry.heightDp <= 0f) return OverlayLayout.DEFAULT
        return OverlayLayout(
            spots = listOf(cornerSpot(geometry), OverlayAnchor(OverlayAnchor.DEFAULT_X, ABOVE_KEYBOARD_DP)),
            activeIndex = 0,
            arrangement = OverlayArrangement.FREE
        )
    }

    /**
     * The bottom-left corner spot. The resting button is a capsule of radius r = [OverlayGeometry.RESTING_H_DP] / 2;
     * set in from both edges by the display's corner radius R less r, its own corner arc is
     * concentric with the display's rounded corner. A square or unreported corner (R = 0), or one
     * tighter than the button's, falls back to the usual edge margin.
     *
     * Horizontally that is the spot's x, as a fraction of the width. Vertically the spot model
     * measures from the keyboard's top edge, and the defaults cannot know how tall the keyboard
     * will be; the corner's depth is measured from the top of the display instead, which no
     * keyboard reaches, so the button always gets at least as far down as the corner and the edge
     * clamp in [OverlayGeometry.anchorPoint] parks it there, [OverlayGeometry.EDGE_MARGIN_DP] off
     * the bottom edge.
     */
    fun cornerSpot(geometry: DisplayGeometry): OverlayAnchor {
        val r = OverlayGeometry.RESTING_H_DP / 2f
        val inset = max(geometry.cornerRadiusDp - r, OverlayGeometry.EDGE_MARGIN_DP)
        val cx = inset + OverlayGeometry.RESTING_W_DP / 2f
        val cy = geometry.heightDp - inset - r
        return OverlayAnchor(
            xFraction = (cx / geometry.widthDp).coerceIn(0f, 1f),
            offsetDp = -cy.roundToInt().toFloat()
        ).rounded()
    }
}
