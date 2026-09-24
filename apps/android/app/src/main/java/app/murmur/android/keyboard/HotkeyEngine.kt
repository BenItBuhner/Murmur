package app.murmur.android.keyboard

import app.murmur.android.dictation.DictationMode
import app.murmur.android.settings.HandsFreeTrigger

sealed class HotkeyAction {
    data class Start(val mode: DictationMode) : HotkeyAction()
    data object Lock : HotkeyAction()
    data object Stop : HotkeyAction()
    data object Cancel : HotkeyAction()
}

data class HotkeyEngineConfig(
    val pushToTalk: List<Int>,
    val handsFree: List<Int>,
    val commandMode: List<Int>,
    val handsFreeTrigger: HandsFreeTrigger,
    val tapThresholdMs: Int,
    val doubleTapWindowMs: Int,
    val sideSensitive: Boolean,
    val escapeCancels: Boolean
)

/**
 * Pure state machine that turns raw key down/up events into dictation actions. Port of
 * apps/desktop/src/core/hotkey/engine.ts, kept in step with it so a shortcut behaves the same on
 * a tablet as on the desktop:
 *
 *  - Press chord            -> [HotkeyAction.Start] at once (audio must begin on press, not release).
 *  - Hold >= tapThreshold, release -> [HotkeyAction.Stop] (transcribe + insert).
 *  - Hold <  tapThreshold, release -> a *tap*:
 *        trigger TAP        -> [HotkeyAction.Lock] (hands-free; keep recording)
 *        trigger DOUBLE_TAP -> Stop; a second press within doubleTapWindow starts locked
 *        trigger OFF        -> Stop
 *  - While locked, pressing any dictation chord -> Stop.
 *  - Dedicated hands-free chord toggles a locked session on press.
 *  - Hands-free chord pressed while holding push-to-talk upgrades the session to locked.
 *  - Esc while listening -> [HotkeyAction.Cancel].
 *
 * The engine never owns timers; the host feeds monotonic timestamps. Codes are desktop codes
 * ([Keys]); the host translates Android keycodes before calling in.
 */
class HotkeyEngine(config: HotkeyEngineConfig) {
    private data class Session(val mode: DictationMode, var chord: ChordId, val startedAt: Long, var locked: Boolean)

    var config: HotkeyEngineConfig = config
        private set
    private val down = LinkedHashSet<Int>()
    private var session: Session? = null
    private var lastTapAt: Long? = null
    private var chords: Map<ChordId, List<Int>> = emptyMap()

    /** The chord (canonical codes) the most recent [keyDown] completed; empty when it completed none. */
    var lastMatchedChord: List<Int> = emptyList()
        private set

    init {
        applyConfig(config)
    }

    fun applyConfig(config: HotkeyEngineConfig) {
        this.config = config
        chords = mapOf(
            ChordId.PUSH_TO_TALK to Keys.canonicalChord(config.pushToTalk, config.sideSensitive),
            ChordId.HANDS_FREE to Keys.canonicalChord(config.handsFree, config.sideSensitive),
            ChordId.COMMAND to Keys.canonicalChord(config.commandMode, config.sideSensitive)
        )
    }

    /** Forget all pressed keys (the host lost track, or the filter restarted). */
    fun reset() {
        down.clear()
        session = null
        lastTapAt = null
    }

    val isListening: Boolean get() = session != null
    val isLocked: Boolean get() = session?.locked ?: false
    val currentMode: DictationMode? get() = session?.mode

    /** The chord of the session in flight, so the host knows which keys belong to it. */
    val sessionChord: List<Int> get() = session?.let { chords[it.chord] } ?: emptyList()

    /** A session ended for reasons the engine did not initiate (the button, the duration cap, an error). */
    fun externalStop() {
        session = null
    }

    /** The UI started a hands-free session (the floating button). */
    fun externalStart(mode: DictationMode, now: Long) {
        session = Session(mode, ChordId.HANDS_FREE, now, locked = true)
    }

    fun keyDown(rawCode: Int, now: Long): List<HotkeyAction> {
        val code = Keys.canonicalKey(rawCode, config.sideSensitive)
        lastMatchedChord = emptyList()
        if (!down.add(code)) return emptyList() // key repeat

        if (code == Key.ESCAPE) {
            if (session != null && config.escapeCancels) {
                session = null
                return listOf(HotkeyAction.Cancel)
            }
            return emptyList()
        }

        val activated = newlyActiveChords(code)
        if (activated.isEmpty()) return emptyList()
        // Prefer the most specific (longest) chord when several complete at once.
        val chord = activated.first()
        lastMatchedChord = chords[chord] ?: emptyList()

        val current = session
        if (current != null) {
            if (current.locked) {
                // Any dictation chord press ends a hands-free session.
                session = null
                return listOf(HotkeyAction.Stop)
            }
            if (chord == ChordId.HANDS_FREE && current.mode != DictationMode.COMMAND) {
                current.locked = true
                current.chord = ChordId.HANDS_FREE
                return listOf(HotkeyAction.Lock)
            }
            // A different chord completing during a hold (a key added to it) is ignored.
            return emptyList()
        }

        if (chord == ChordId.HANDS_FREE) {
            session = Session(DictationMode.HANDS_FREE, chord, now, locked = true)
            return listOf(HotkeyAction.Start(DictationMode.HANDS_FREE))
        }
        if (chord == ChordId.COMMAND) {
            session = Session(DictationMode.COMMAND, chord, now, locked = false)
            return listOf(HotkeyAction.Start(DictationMode.COMMAND))
        }

        // Push to talk.
        val last = lastTapAt
        val isDoubleTap = config.handsFreeTrigger == HandsFreeTrigger.DOUBLE_TAP &&
            last != null && now - last <= config.doubleTapWindowMs
        lastTapAt = null
        if (isDoubleTap) {
            session = Session(DictationMode.HANDS_FREE, chord, now, locked = true)
            return listOf(HotkeyAction.Start(DictationMode.HANDS_FREE))
        }
        session = Session(DictationMode.HOLD, chord, now, locked = false)
        return listOf(HotkeyAction.Start(DictationMode.HOLD))
    }

    fun keyUp(rawCode: Int, now: Long): List<HotkeyAction> {
        val code = Keys.canonicalKey(rawCode, config.sideSensitive)
        if (!down.remove(code)) return emptyList()

        val current = session ?: return emptyList()
        if (current.locked) return emptyList()
        if (code !in (chords[current.chord] ?: emptyList())) return emptyList()

        val held = now - current.startedAt
        if (held < config.tapThresholdMs && current.mode != DictationMode.COMMAND) {
            when (config.handsFreeTrigger) {
                HandsFreeTrigger.TAP -> {
                    current.locked = true
                    return listOf(HotkeyAction.Lock)
                }
                HandsFreeTrigger.DOUBLE_TAP -> {
                    lastTapAt = now
                    session = null
                    return listOf(HotkeyAction.Stop)
                }
                HandsFreeTrigger.OFF -> Unit
            }
        }
        session = null
        return listOf(HotkeyAction.Stop)
    }

    /** Chords that are fully pressed and include the key that just went down, longest first. */
    private fun newlyActiveChords(code: Int): List<ChordId> =
        listOf(ChordId.HANDS_FREE, ChordId.COMMAND, ChordId.PUSH_TO_TALK)
            .filter { id ->
                val keys = chords[id] ?: emptyList()
                keys.isNotEmpty() && code in keys && keys.all { it in down }
            }
            .sortedByDescending { chords[it]?.size ?: 0 }

    /** The keys the engine believes are held right now (canonical codes), for diagnostics and tests. */
    fun heldKeys(): Set<Int> = down.toSet()
}
