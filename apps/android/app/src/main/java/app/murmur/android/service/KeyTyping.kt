package app.murmur.android.service

import android.view.KeyCharacterMap
import android.view.KeyEvent

/**
 * The slice of the virtual keyboard's [KeyCharacterMap] that typing needs, behind an interface so
 * the device's exact behaviour — including the characters it refuses — can be exercised in unit
 * tests, where Robolectric's stand-in map knows only a handful of keys and refuses nothing.
 */
interface KeyMap {
    /** The key presses, modifiers included, that type [ch]; null when no key produces it. */
    fun eventsFor(ch: Char): Array<KeyEvent>?

    /** What [keyCode] types with [metaState] held, exactly as [KeyCharacterMap.get] reports it. */
    fun charFor(keyCode: Int, metaState: Int): Int
}

/** The platform's virtual keyboard map, the one soft keyboards type with; refuses everything if it cannot load. */
class VirtualKeyMap(private val map: KeyCharacterMap?) : KeyMap {
    constructor() : this(runCatching { KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD) }.getOrNull())

    override fun eventsFor(ch: Char): Array<KeyEvent>? = map?.getEvents(charArrayOf(ch))
    override fun charFor(keyCode: Int, metaState: Int): Int = map?.get(keyCode, metaState) ?: 0
}

private const val SHIFT_STATE = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON or KeyEvent.META_SHIFT_RIGHT_ON

/**
 * Types [text] into an editor that reads the key stream (a terminal's TYPE_NULL view).
 *
 * A character goes in as a key press only when a key types it plainly, alone or with Shift, and
 * reads back as the same character. Everything else is committed as text in its place, one run at
 * a time, so a single character no key produces never moves the rest of the dictation off the key
 * stream:
 *  - characters the map refuses outright (’ ‘ “ ” — … é, emoji);
 *  - letters it only reaches through Alt (ç, ß): a terminal reads Left Alt as Meta and would get
 *    Escape followed by the bare letter;
 *  - combining accents, which it maps to Alt dead keys: an editor holding a dead key merges it with,
 *    or swallows, the key that follows. The accent is committed together with the letter it sits on.
 */
fun typeAsKeys(text: String, keys: KeyMap, sendKey: (KeyEvent) -> Unit, commit: (String) -> Unit) {
    val pending = StringBuilder()
    for ((i, ch) in text.withIndex()) {
        val events = if (text.getOrNull(i + 1)?.isMark() == true) null else plainKeys(ch, keys)
        if (events == null) {
            pending.append(ch)
            continue
        }
        if (pending.isNotEmpty()) {
            commit(pending.toString())
            pending.clear()
        }
        events.forEach(sendKey)
    }
    if (pending.isNotEmpty()) commit(pending.toString())
}

/** The presses that type [ch] with at most Shift held, or null when no such key reads back as [ch]. */
private fun plainKeys(ch: Char, keys: KeyMap): Array<KeyEvent>? {
    if (ch.isSurrogate()) return null
    val events = runCatching { keys.eventsFor(ch) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    var typed: KeyEvent? = null
    for (event in events) {
        if ((event.metaState and SHIFT_STATE.inv()) != 0) return null
        when {
            event.keyCode == KeyEvent.KEYCODE_SHIFT_LEFT || event.keyCode == KeyEvent.KEYCODE_SHIFT_RIGHT -> Unit
            KeyEvent.isModifierKey(event.keyCode) -> return null
            event.action == KeyEvent.ACTION_DOWN -> if (typed == null) typed = event else return null
        }
    }
    val key = typed ?: return null
    return if (keys.charFor(key.keyCode, key.metaState) == ch.code) events else null
}

/** Combining marks and the joiners and selectors that bind to the character before them. */
private fun Char.isMark(): Boolean = when (Character.getType(this).toByte()) {
    Character.NON_SPACING_MARK, Character.ENCLOSING_MARK, Character.COMBINING_SPACING_MARK -> true
    else -> this == '\u200D' || this in '\uFE00'..'\uFE0F'
}
