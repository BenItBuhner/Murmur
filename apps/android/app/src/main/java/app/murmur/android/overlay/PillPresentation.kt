package app.murmur.android.overlay

import app.murmur.android.keyboard.DevicePosture
import app.murmur.android.keyboard.desktopOverlayOn
import app.murmur.android.settings.KeyboardSettings
import app.murmur.android.settings.OverlayPosition

/**
 * How the overlay presents itself. [Button] is the phone's floating dictation button: it rests on
 * one of its spots beside the keyboard and can be dragged between them. [Desktop] is the desktop
 * app's pill: parked at one of the desktop's three positions, a thin idle bar when Murmur is ready
 * (or nothing, with the idle indicator off), grown into the listening pill by a shortcut or a tap.
 */
sealed interface PillPresentation {
    data object Button : PillPresentation

    data class Desktop(
        val position: OverlayPosition,
        val showIdle: Boolean,
        /**
         * Draw the cancel and confirm buttons on the listening pill. A desktop with a keyboard has
         * Esc and the shortcut for those; a large touch-only screen has nothing else.
         */
        val touchControls: Boolean
    ) : PillPresentation

    companion object {
        /** The presentation for the keyboard settings on a device in [posture]. */
        fun resolve(keyboard: KeyboardSettings, posture: DevicePosture): PillPresentation =
            if (desktopOverlayOn(keyboard.desktopOverlay, posture)) {
                Desktop(keyboard.overlayPosition, keyboard.showOverlayWhenIdle, touchControls = !posture.hardwareKeyboard)
            } else {
                Button
            }
    }
}
