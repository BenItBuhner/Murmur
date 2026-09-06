package app.murmur.android.overlay

import app.murmur.android.service.MurmurAccessibilityService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * "Edit position" mode for the dictation button. While on, the accessibility service shows the
 * button on a full-screen drag surface (with the keyboard still visible underneath) so the user
 * can park it anywhere, e.g. on the keyboard's toolbar row. The settings screen starts it and
 * both the screen and the on-screen Done chip can end it.
 */
object OverlayEditor {
    private val _editing = MutableStateFlow(false)
    val editing: StateFlow<Boolean> = _editing

    /** @return false when the accessibility service (which owns the overlay) is not running. */
    fun start(): Boolean {
        if (!MurmurAccessibilityService.isRunning) return false
        _editing.value = true
        return true
    }

    fun stop() {
        _editing.value = false
    }
}
