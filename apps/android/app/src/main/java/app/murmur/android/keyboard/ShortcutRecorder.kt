package app.murmur.android.keyboard

import app.murmur.android.service.MurmurAccessibilityService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The bridge between the shortcut recorder on the Keyboard screen and the accessibility service,
 * which is the only place hardware key events arrive. The screen asks for a capture; the service
 * streams what it sees ([capture]) so the recorder shows exactly the keys that will be matched later,
 * and the final snapshot ends the capture.
 */
object ShortcutRecorder {
    private val _capturing = MutableStateFlow(false)
    val capturing: StateFlow<Boolean> = _capturing

    private val _capture = MutableStateFlow<ShortcutCapture?>(null)
    val capture: StateFlow<ShortcutCapture?> = _capture

    /** @return false when the accessibility service (which sees the keys) is not running. */
    fun start(): Boolean {
        if (!MurmurAccessibilityService.isRunning) return false
        _capture.value = null
        _capturing.value = true
        return true
    }

    fun stop() {
        _capturing.value = false
    }

    internal fun publish(snapshot: ShortcutCapture) {
        _capture.value = snapshot
        if (snapshot.final) _capturing.value = false
    }
}
