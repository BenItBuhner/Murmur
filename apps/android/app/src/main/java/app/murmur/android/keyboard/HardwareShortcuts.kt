package app.murmur.android.keyboard

import android.view.KeyEvent
import app.murmur.android.dictation.DictationMode

/** What the shortcut recorder shows while a chord is being pressed, and what it ends with. */
data class ShortcutCapture(
    val keys: List<Int>,
    val label: String,
    val valid: Boolean,
    val reason: String? = null,
    /** All keys were released (or the capture was cancelled): this is the result. */
    val final: Boolean = false
)

/**
 * Turns the key events the accessibility service filters into dictation actions, and decides which
 * of them the rest of the system may see. Port of the desktop `HookService` around the shared
 * [HotkeyEngine], with one difference the platform forces: the desktop hook only listens, but an
 * Android key event the service handles never reaches the app, so consumption is a decision.
 *
 * The rule is to take only what belongs to a shortcut. The key that completes a chord is taken (the
 * app never sees the Space in Ctrl + Meta + Space), its release is taken to match, and the auto
 * repeats of a held chord key are taken (the app never saw the press they repeat). Keys pressed on
 * their own, and every key of a chord that never completes, pass through untouched, so typing is
 * never affected.
 *
 * Modifiers pressed before the chord completed were already passed through, and their release
 * passes through too, except Meta. Android acts on a Meta pressed and released with nothing in
 * between (the app search, the DeX app list), and once Meta has taken part in a shortcut that is
 * what its release would look like, so it is taken. The system keeps an unmatched Meta press, which
 * it does nothing with. Escape is taken only while a session is being cancelled.
 *
 * While the recorder captures a shortcut every key is taken (the capture screen is Murmur's own),
 * except Back and Home, which end the capture and pass through.
 */
class HardwareShortcuts(
    config: HotkeyEngineConfig,
    private val onAction: (HotkeyAction) -> Unit
) {
    private val engine = HotkeyEngine(config)

    /** Keys (side-specific desktop codes) whose press was taken, so their release and repeats are taken too. */
    private val taken = HashSet<Int>()

    /** Keys held right now, in the order they went down. */
    private val held = LinkedHashSet<Int>()

    private var capture: Capture? = null

    private class Capture(val onCapture: (ShortcutCapture) -> Unit) {
        val down = LinkedHashSet<Int>()
        var combo: List<Int> = emptyList()
    }

    val isListening: Boolean get() = engine.isListening
    val isCapturing: Boolean get() = capture != null

    /** True while any key the filter has seen pressed is still down. */
    val anyKeyDown: Boolean get() = held.isNotEmpty()

    fun applyConfig(config: HotkeyEngineConfig) {
        engine.applyConfig(config)
    }

    /** Forget every pressed key (the service reconnected, or the keyboard went away mid-chord). */
    fun reset() {
        engine.reset()
        taken.clear()
        held.clear()
    }

    /**
     * A session ended for a reason the keys did not cause (the button, the duration cap, an error),
     * or began from the button: keep the engine's idea of "listening" true to what the pill shows.
     */
    fun syncSession(listening: Boolean, mode: DictationMode?, now: Long) {
        if (listening && !engine.isListening) engine.externalStart(mode ?: DictationMode.HANDS_FREE, now)
        if (!listening && engine.isListening) engine.externalStop()
    }

    // ---- capture mode -------------------------------------------------------------------------

    /** Record the next chord: live snapshots while keys are held, a final one once they are all released. */
    fun startCapture(onCapture: (ShortcutCapture) -> Unit) {
        capture = Capture(onCapture)
        engine.reset()
        onCapture(snapshot(emptyList(), final = false))
    }

    fun stopCapture() {
        capture = null
    }

    private fun snapshot(combo: List<Int>, final: Boolean): ShortcutCapture {
        val sideSensitive = engine.config.sideSensitive
        val keys = Keys.canonicalChord(combo, sideSensitive)
        val v = Keys.validateChord(keys, sideSensitive)
        return ShortcutCapture(
            keys = keys,
            label = if (keys.isNotEmpty()) Keys.chordLabel(keys, sideSensitive) else if (final) "Not set" else "Press your shortcut…",
            valid = v.valid,
            reason = v.reason,
            final = final
        )
    }

    // ---- key events ---------------------------------------------------------------------------

    /**
     * One filtered key event. @return true to take it (the rest of the system never sees it),
     * false to let it through. [now] is a monotonic clock in milliseconds.
     */
    fun onKeyEvent(event: KeyEvent, now: Long): Boolean {
        val code = Keys.fromAndroid(event.keyCode)
        return when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount > 0) onRepeat(code) else onDown(event.keyCode, code, now)
            KeyEvent.ACTION_UP -> onUp(code, now)
            else -> false
        }
    }

    private fun onDown(keyCode: Int, code: Int, now: Long): Boolean {
        held.add(code)
        val capture = capture
        if (capture != null) {
            if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_HOME) {
                this.capture = null
                capture.onCapture(ShortcutCapture(emptyList(), "Not set", valid = false, reason = "Cancelled", final = true))
                return false
            }
            if (code == Key.ESCAPE) {
                this.capture = null
                capture.onCapture(ShortcutCapture(emptyList(), "Not set", valid = false, reason = "Cancelled", final = true))
                taken.add(code)
                return true
            }
            capture.down.add(code)
            if (capture.down.size >= capture.combo.size) capture.combo = capture.down.toList()
            capture.onCapture(snapshot(capture.combo, final = false))
            taken.add(code)
            return true
        }

        val actions = engine.keyDown(code, now)
        if (actions.isEmpty()) return false
        // The key completed a chord (or cancelled a session): it, and every held key of the chord it
        // completed, now belong to the shortcut.
        taken.add(code)
        val sideSensitive = engine.config.sideSensitive
        val chord = engine.lastMatchedChord
        for (k in held) {
            val canonical = Keys.canonicalKey(k, sideSensitive)
            if (canonical in chord && canonical == Key.META) taken.add(k)
        }
        for (a in actions) onAction(a)
        return true
    }

    private fun onRepeat(code: Int): Boolean = code in taken

    private fun onUp(code: Int, now: Long): Boolean {
        held.remove(code)
        val capture = capture
        if (capture != null) {
            capture.down.remove(code)
            val wasTaken = taken.remove(code)
            if (capture.down.isEmpty() && capture.combo.isNotEmpty()) {
                this.capture = null
                capture.onCapture(snapshot(capture.combo, final = true))
            }
            return wasTaken
        }

        val actions = engine.keyUp(code, now)
        for (a in actions) onAction(a)
        // Taken exactly when the press was: the app sees a release for every press it saw, and never
        // one for a press it did not, whatever order the chord is let go in.
        val consumed = taken.remove(code)
        if (!engine.isListening && held.isEmpty()) taken.clear()
        return consumed
    }
}
