package app.murmur.android

import android.view.KeyCharacterMap
import android.view.KeyEvent
import app.murmur.android.service.KeyMap
import java.util.TreeMap

/**
 * The virtual keyboard's character map as a phone has it: the behaviours of AOSP's
 * `frameworks/base/data/keyboards/Virtual.kcm` (byte-identical on a Galaxy S25 Ultra running
 * Android 16), resolved the way `libinput`'s `KeyCharacterMap` resolves them. [eventsFor] refuses a
 * character no key produces, takes the first key in key-code order, and wraps a modified key in its
 * modifier's own presses; [charFor] reports a combining accent as a dead key, like
 * `KeyCharacterMap.get`. Robolectric's built-in map cannot stand in for it: it types a character it
 * does not know as `KEYCODE_UNKNOWN` instead of refusing it, and it has no Alt layer.
 */
class DeviceKeyMap : KeyMap {
    private class Behavior(val meta: Int, val ch: Char)

    private val keys = TreeMap<Int, List<Behavior>>()

    init {
        val altOf = mapOf('c' to '\u00e7', 'e' to '\u0301', 'i' to '\u0302', 'n' to '\u0303', 's' to '\u00df', 'u' to '\u0308')
        for (c in 'a'..'z') {
            val behaviors = mutableListOf(Behavior(0, c), Behavior(SHIFT, c.uppercaseChar()))
            altOf[c]?.let { behaviors.add(Behavior(ALT, it)) }
            if (c == 'c') behaviors.add(Behavior(SHIFT or ALT, '\u00c7'))
            keys[KeyEvent.KEYCODE_A + (c - 'a')] = behaviors
        }
        val shifted = ")!@#$%^&*("
        for (d in 0..9) {
            val behaviors = mutableListOf(Behavior(0, '0' + d), Behavior(SHIFT, shifted[d]))
            if (d == 6) behaviors.add(Behavior(SHIFT or ALT, '\u0302'))
            keys[KeyEvent.KEYCODE_0 + d] = behaviors
        }
        keys[KeyEvent.KEYCODE_SPACE] = listOf(Behavior(0, ' '))
        keys[KeyEvent.KEYCODE_ENTER] = listOf(Behavior(0, '\n'))
        keys[KeyEvent.KEYCODE_TAB] = listOf(Behavior(0, '\t'))
        keys[KeyEvent.KEYCODE_GRAVE] = listOf(Behavior(0, '`'), Behavior(SHIFT, '~'), Behavior(ALT, '\u0300'), Behavior(SHIFT or ALT, '\u0303'))
        for ((code, pair) in listOf(
            KeyEvent.KEYCODE_COMMA to ",<", KeyEvent.KEYCODE_PERIOD to ".>", KeyEvent.KEYCODE_SLASH to "/?",
            KeyEvent.KEYCODE_MINUS to "-_", KeyEvent.KEYCODE_EQUALS to "=+", KeyEvent.KEYCODE_LEFT_BRACKET to "[{",
            KeyEvent.KEYCODE_RIGHT_BRACKET to "]}", KeyEvent.KEYCODE_BACKSLASH to "\\|",
            KeyEvent.KEYCODE_SEMICOLON to ";:", KeyEvent.KEYCODE_APOSTROPHE to "'\"",
        )) keys[code] = listOf(Behavior(0, pair[0]), Behavior(SHIFT, pair[1]))
    }

    override fun eventsFor(ch: Char): Array<KeyEvent>? {
        for ((code, behaviors) in keys) {
            val behavior = behaviors.firstOrNull { it.ch == ch } ?: continue
            return press(code, behavior.meta)
        }
        return null
    }

    override fun charFor(keyCode: Int, metaState: Int): Int {
        val wanted = (if (metaState and ANY_SHIFT != 0) SHIFT else 0) or (if (metaState and ANY_ALT != 0) ALT else 0)
        val ch = keys[keyCode]?.firstOrNull { it.meta == wanted }?.ch ?: return 0
        return DEAD_KEYS[ch]?.let { it or KeyCharacterMap.COMBINING_ACCENT } ?: ch.code
    }

    private fun press(code: Int, meta: Int): Array<KeyEvent> {
        val out = ArrayList<KeyEvent>()
        var current = 0
        fun add(action: Int, keyCode: Int) {
            out.add(KeyEvent(0L, 0L, action, keyCode, 0, current))
        }
        if (meta and SHIFT != 0) { current = current or SHIFT_LEFT; add(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_SHIFT_LEFT) }
        if (meta and ALT != 0) { current = current or ALT_LEFT; add(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ALT_LEFT) }
        add(KeyEvent.ACTION_DOWN, code)
        add(KeyEvent.ACTION_UP, code)
        if (meta and ALT != 0) { current = current and ALT_LEFT.inv(); add(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ALT_LEFT) }
        if (meta and SHIFT != 0) { current = current and SHIFT_LEFT.inv(); add(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_SHIFT_LEFT) }
        return out.toTypedArray()
    }

    private companion object {
        const val SHIFT = KeyEvent.META_SHIFT_ON
        const val ALT = KeyEvent.META_ALT_ON
        const val SHIFT_LEFT = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        const val ALT_LEFT = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        const val ANY_SHIFT = KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON or KeyEvent.META_SHIFT_RIGHT_ON
        const val ANY_ALT = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON or KeyEvent.META_ALT_RIGHT_ON

        /** `KeyCharacterMap.sCombiningToAccent` for the accents Virtual.kcm puts on its Alt layer. */
        val DEAD_KEYS = mapOf('\u0300' to 0x02CB, '\u0301' to 0x00B4, '\u0302' to 0x02C6, '\u0303' to 0x02DC, '\u0308' to 0x00A8)
    }
}
