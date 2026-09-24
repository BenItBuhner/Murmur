package app.murmur.android.keyboard

import app.murmur.android.service.MurmurAccessibilityService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** One snapshot of a capture, tagged with the capture session it belongs to. */
data class CaptureEvent(val session: Int, val snapshot: ShortcutCapture)

/**
 * The bridge between the shortcut recorders on the Keyboard screen and the accessibility service,
 * which is the only place hardware key events arrive. A recorder asks for a capture and gets a
 * session number back; the service streams what it sees ([capture]) so the recorder shows exactly
 * the keys that will be matched later, and the final snapshot ends the capture. Only one capture
 * runs at a time: starting another ends the one before it.
 */
object ShortcutRecorder {
    private val _session = MutableStateFlow<Int?>(null)

    /** The capture session under way, or null. Each new session is a new value, so a restart is seen. */
    val session: StateFlow<Int?> = _session

    private val _capture = MutableStateFlow<CaptureEvent?>(null)
    val capture: StateFlow<CaptureEvent?> = _capture

    private var counter = 0

    /** Test seam: whether the service that sees the keys is there. Tests stand in for it and publish captures themselves. */
    @androidx.annotation.VisibleForTesting
    internal var serviceRunning: () -> Boolean = { MurmurAccessibilityService.isRunning }

    /** @return the capture session, or null when the accessibility service (which sees the keys) is not running. */
    fun start(): Int? {
        if (!serviceRunning()) return null
        val next = ++counter
        _capture.value = null
        _session.value = next
        return next
    }

    /** End [session] if it is still the one running; a newer session is left alone. */
    fun stop(session: Int) {
        if (_session.value == session) _session.value = null
    }

    fun stop() {
        _session.value = null
    }

    internal fun publish(snapshot: ShortcutCapture) {
        val current = _session.value ?: counter
        _capture.value = CaptureEvent(current, snapshot)
        if (snapshot.final) _session.value = null
    }
}
