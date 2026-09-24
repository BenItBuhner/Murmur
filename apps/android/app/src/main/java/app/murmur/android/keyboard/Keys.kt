package app.murmur.android.keyboard

import android.view.KeyEvent

/**
 * Key identity for hardware-keyboard shortcuts. Port of apps/desktop/src/core/hotkey/keys.ts: a
 * chord is stored as the desktop app's libuiohook keycodes, so a shortcut written by either app
 * names the same keys (Ctrl + Meta is `[29, 3675]` on both) and the two settings schemas stay
 * interchangeable. Android delivers [KeyEvent] keycodes; [Keys.fromAndroid] translates them on the
 * way in, and a key the desktop table has no code for keeps its Android keycode in a range of its
 * own ([Keys.ANDROID_BASE]) so it can still be bound.
 */
object Key {
    const val ESCAPE = 1
    const val BACKSPACE = 14
    const val TAB = 15
    const val ENTER = 28
    const val CTRL = 29
    const val CTRL_RIGHT = 3613
    const val SHIFT = 42
    const val SHIFT_RIGHT = 54
    const val ALT = 56
    const val ALT_RIGHT = 3640
    const val SPACE = 57
    const val CAPS_LOCK = 58
    const val META = 3675
    const val META_RIGHT = 3676
    const val F1 = 59
    const val F2 = 60
    const val F3 = 61
    const val F4 = 62
    const val F5 = 63
    const val F6 = 64
    const val F7 = 65
    const val F8 = 66
    const val F9 = 67
    const val F10 = 68
    const val F11 = 87
    const val F12 = 88
    const val INSERT = 3666
    const val DELETE = 3667
    const val HOME = 3655
    const val END = 3663
    const val PAGE_UP = 3657
    const val PAGE_DOWN = 3665
    const val ARROW_LEFT = 57419
    const val ARROW_UP = 57416
    const val ARROW_RIGHT = 57421
    const val ARROW_DOWN = 57424
    const val PRINT_SCREEN = 3639
    const val SCROLL_LOCK = 70
    const val NUM_LOCK = 69
    const val A = 30
    const val C = 46
    const val H = 35
    const val L = 38
    const val N = 49
    const val V = 47
    const val X = 45
    const val Z = 44
}

/** The three ways a chord can be bound, in the desktop settings' field names. */
enum class ChordId { PUSH_TO_TALK, HANDS_FREE, COMMAND }

data class ChordValidation(val valid: Boolean, val reason: String? = null)

object Keys {
    /** Keys without a desktop code are stored as this plus their Android keycode. */
    const val ANDROID_BASE = 40_000

    private val LETTERS: Map<Int, Char> = mapOf(
        30 to 'A', 48 to 'B', 46 to 'C', 32 to 'D', 18 to 'E', 33 to 'F', 34 to 'G', 35 to 'H', 23 to 'I',
        36 to 'J', 37 to 'K', 38 to 'L', 50 to 'M', 49 to 'N', 24 to 'O', 25 to 'P', 16 to 'Q', 19 to 'R',
        31 to 'S', 20 to 'T', 22 to 'U', 47 to 'V', 17 to 'W', 45 to 'X', 21 to 'Y', 44 to 'Z'
    )
    private val DIGITS: Map<Int, Char> = mapOf(
        11 to '0', 2 to '1', 3 to '2', 4 to '3', 5 to '4', 6 to '5', 7 to '6', 8 to '7', 9 to '8', 10 to '9'
    )
    private val NUMPAD: Map<Int, String> = mapOf(
        82 to "Num0", 79 to "Num1", 80 to "Num2", 81 to "Num3", 75 to "Num4", 76 to "Num5", 77 to "Num6",
        71 to "Num7", 72 to "Num8", 73 to "Num9", 55 to "Num*", 78 to "Num+", 74 to "Num-", 83 to "Num.", 3637 to "Num/"
    )
    private val PUNCT: Map<Int, Char> = mapOf(
        41 to '`', 12 to '-', 13 to '=', 26 to '[', 27 to ']', 43 to '\\', 39 to ';', 40 to '\'', 51 to ',', 52 to '.', 53 to '/'
    )

    val MODIFIERS: Set<Int> = setOf(
        Key.CTRL, Key.CTRL_RIGHT, Key.SHIFT, Key.SHIFT_RIGHT, Key.ALT, Key.ALT_RIGHT, Key.META, Key.META_RIGHT
    )

    private val RIGHT_TO_LEFT: Map<Int, Int> = mapOf(
        Key.CTRL_RIGHT to Key.CTRL, Key.SHIFT_RIGHT to Key.SHIFT, Key.ALT_RIGHT to Key.ALT, Key.META_RIGHT to Key.META
    )
    private val LEFT_TO_RIGHT: Map<Int, Int> = RIGHT_TO_LEFT.entries.associate { (r, l) -> l to r }

    /** Android keycode -> desktop code, for every key the desktop table names. */
    private val FROM_ANDROID: Map<Int, Int> = buildMap {
        put(KeyEvent.KEYCODE_ESCAPE, Key.ESCAPE)
        put(KeyEvent.KEYCODE_DEL, Key.BACKSPACE)
        put(KeyEvent.KEYCODE_TAB, Key.TAB)
        put(KeyEvent.KEYCODE_ENTER, Key.ENTER)
        put(KeyEvent.KEYCODE_NUMPAD_ENTER, Key.ENTER)
        put(KeyEvent.KEYCODE_CTRL_LEFT, Key.CTRL)
        put(KeyEvent.KEYCODE_CTRL_RIGHT, Key.CTRL_RIGHT)
        put(KeyEvent.KEYCODE_SHIFT_LEFT, Key.SHIFT)
        put(KeyEvent.KEYCODE_SHIFT_RIGHT, Key.SHIFT_RIGHT)
        put(KeyEvent.KEYCODE_ALT_LEFT, Key.ALT)
        put(KeyEvent.KEYCODE_ALT_RIGHT, Key.ALT_RIGHT)
        put(KeyEvent.KEYCODE_SPACE, Key.SPACE)
        put(KeyEvent.KEYCODE_CAPS_LOCK, Key.CAPS_LOCK)
        put(KeyEvent.KEYCODE_META_LEFT, Key.META)
        put(KeyEvent.KEYCODE_META_RIGHT, Key.META_RIGHT)
        for (i in 0 until 12) put(KeyEvent.KEYCODE_F1 + i, if (i < 10) Key.F1 + i else Key.F11 + (i - 10))
        put(KeyEvent.KEYCODE_INSERT, Key.INSERT)
        put(KeyEvent.KEYCODE_FORWARD_DEL, Key.DELETE)
        put(KeyEvent.KEYCODE_MOVE_HOME, Key.HOME)
        put(KeyEvent.KEYCODE_MOVE_END, Key.END)
        put(KeyEvent.KEYCODE_PAGE_UP, Key.PAGE_UP)
        put(KeyEvent.KEYCODE_PAGE_DOWN, Key.PAGE_DOWN)
        put(KeyEvent.KEYCODE_DPAD_LEFT, Key.ARROW_LEFT)
        put(KeyEvent.KEYCODE_DPAD_UP, Key.ARROW_UP)
        put(KeyEvent.KEYCODE_DPAD_RIGHT, Key.ARROW_RIGHT)
        put(KeyEvent.KEYCODE_DPAD_DOWN, Key.ARROW_DOWN)
        put(KeyEvent.KEYCODE_SYSRQ, Key.PRINT_SCREEN)
        put(KeyEvent.KEYCODE_SCROLL_LOCK, Key.SCROLL_LOCK)
        put(KeyEvent.KEYCODE_NUM_LOCK, Key.NUM_LOCK)
        for ((code, letter) in LETTERS) put(KeyEvent.KEYCODE_A + (letter - 'A'), code)
        for ((code, digit) in DIGITS) put(KeyEvent.KEYCODE_0 + (digit - '0'), code)
        put(KeyEvent.KEYCODE_GRAVE, 41)
        put(KeyEvent.KEYCODE_MINUS, 12)
        put(KeyEvent.KEYCODE_EQUALS, 13)
        put(KeyEvent.KEYCODE_LEFT_BRACKET, 26)
        put(KeyEvent.KEYCODE_RIGHT_BRACKET, 27)
        put(KeyEvent.KEYCODE_BACKSLASH, 43)
        put(KeyEvent.KEYCODE_SEMICOLON, 39)
        put(KeyEvent.KEYCODE_APOSTROPHE, 40)
        put(KeyEvent.KEYCODE_COMMA, 51)
        put(KeyEvent.KEYCODE_PERIOD, 52)
        put(KeyEvent.KEYCODE_SLASH, 53)
        val numpad = listOf(82, 79, 80, 81, 75, 76, 77, 71, 72, 73)
        for (i in 0 until 10) put(KeyEvent.KEYCODE_NUMPAD_0 + i, numpad[i])
        put(KeyEvent.KEYCODE_NUMPAD_MULTIPLY, 55)
        put(KeyEvent.KEYCODE_NUMPAD_ADD, 78)
        put(KeyEvent.KEYCODE_NUMPAD_SUBTRACT, 74)
        put(KeyEvent.KEYCODE_NUMPAD_DOT, 83)
        put(KeyEvent.KEYCODE_NUMPAD_DIVIDE, 3637)
    }

    /** The desktop code for an Android keycode, or its own code in the Android range. */
    fun fromAndroid(keyCode: Int): Int = FROM_ANDROID[keyCode] ?: (ANDROID_BASE + keyCode)

    fun isAndroidOnly(code: Int): Boolean = code >= ANDROID_BASE

    fun isModifier(code: Int): Boolean = code in MODIFIERS

    fun isFunctionKey(code: Int): Boolean =
        code in Key.F1..Key.F10 || code in Key.F11..Key.F12 || code in 91..93 || code in 99..107

    /** Collapse right-hand modifiers onto their left-hand code. */
    fun canonicalKey(code: Int, sideSensitive: Boolean = false): Int =
        if (sideSensitive) code else RIGHT_TO_LEFT[code] ?: code

    /** Canonical, de-duplicated, ordered (modifiers first: Ctrl, Alt, Shift, Meta) chord. */
    fun canonicalChord(keys: Collection<Int>, sideSensitive: Boolean = false): List<Int> =
        keys.map { canonicalKey(it, sideSensitive) }.distinct().sortedWith(compareBy({ modifierRank(it) }, { it }))

    private fun modifierRank(code: Int): Int = when (canonicalKey(code)) {
        Key.CTRL -> 0
        Key.ALT -> 1
        Key.SHIFT -> 2
        Key.META -> 3
        else -> 10
    }

    fun chordsEqual(a: Collection<Int>, b: Collection<Int>, sideSensitive: Boolean = false): Boolean =
        canonicalChord(a, sideSensitive) == canonicalChord(b, sideSensitive)

    /** What a key is called on the recorder's key caps. Android's own name for the Windows / Command key is Meta. */
    fun keyName(code: Int): String {
        when (code) {
            Key.CTRL -> return "Ctrl"
            Key.CTRL_RIGHT -> return "Right Ctrl"
            Key.SHIFT -> return "Shift"
            Key.SHIFT_RIGHT -> return "Right Shift"
            Key.ALT -> return "Alt"
            Key.ALT_RIGHT -> return "Right Alt"
            Key.META -> return "Meta"
            Key.META_RIGHT -> return "Right Meta"
            Key.SPACE -> return "Space"
            Key.ESCAPE -> return "Esc"
            Key.ENTER -> return "Enter"
            Key.TAB -> return "Tab"
            Key.BACKSPACE -> return "Backspace"
            Key.CAPS_LOCK -> return "Caps Lock"
            Key.INSERT -> return "Insert"
            Key.DELETE -> return "Delete"
            Key.HOME -> return "Home"
            Key.END -> return "End"
            Key.PAGE_UP -> return "Page Up"
            Key.PAGE_DOWN -> return "Page Down"
            Key.ARROW_LEFT -> return "←"
            Key.ARROW_RIGHT -> return "→"
            Key.ARROW_UP -> return "↑"
            Key.ARROW_DOWN -> return "↓"
            Key.PRINT_SCREEN -> return "Print Screen"
            Key.SCROLL_LOCK -> return "Scroll Lock"
            Key.NUM_LOCK -> return "Num Lock"
        }
        if (isFunctionKey(code)) return functionKeyName(code)
        LETTERS[code]?.let { return it.toString() }
        DIGITS[code]?.let { return it.toString() }
        NUMPAD[code]?.let { return it }
        PUNCT[code]?.let { return it.toString() }
        if (isAndroidOnly(code)) return androidKeyName(code - ANDROID_BASE)
        return "Key $code"
    }

    private fun functionKeyName(code: Int): String = when {
        code in Key.F1..Key.F10 -> "F${code - 58}"
        code == Key.F11 -> "F11"
        code == Key.F12 -> "F12"
        code in 91..93 -> "F${code - 78}"
        code in 99..107 -> "F${code - 83}"
        else -> "F?"
    }

    /** "KEYCODE_VOLUME_UP" -> "Volume Up". */
    private fun androidKeyName(keyCode: Int): String {
        val raw = KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_")
        if (raw.isEmpty() || raw.all { it.isDigit() }) return "Key $keyCode"
        return raw.lowercase().split('_').joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
    }

    fun chordLabel(keys: Collection<Int>, sideSensitive: Boolean = false): String {
        if (keys.isEmpty()) return "Not set"
        return canonicalChord(keys, sideSensitive).joinToString(" + ") { keyName(it) }
    }

    /**
     * Combinations Android itself acts on (AOSP 13 to 16, Samsung DeX): taking them over would cost the
     * user a system function, so the recorder refuses them, as the desktop recorder refuses Alt + F4.
     * Alt + Meta is on the list because Android toggles Caps Lock on it, which is why the desktop's
     * default for command mode cannot be the default here.
     */
    private val BLOCKED: List<Pair<List<Int>, String>> = listOf(
        listOf(Key.CTRL, Key.A) to "selects all",
        listOf(Key.CTRL, Key.C) to "copies",
        listOf(Key.CTRL, Key.V) to "pastes",
        listOf(Key.CTRL, Key.X) to "cuts",
        listOf(Key.CTRL, Key.Z) to "undoes",
        listOf(Key.ALT, Key.TAB) to "switches apps",
        listOf(Key.META, Key.TAB) to "switches apps",
        listOf(Key.ALT, Key.META) to "toggles Caps Lock",
        listOf(Key.META, Key.L) to "locks the screen",
        listOf(Key.META, Key.H) to "goes home",
        listOf(Key.META, Key.N) to "opens the notifications"
    )

    /**
     * Same rules as the desktop recorder: a modifier (or a function key, or Caps Lock alone), at most
     * three keys, never both sides of one modifier, and none of Android's own combinations.
     */
    fun validateChord(keys: Collection<Int>, sideSensitive: Boolean = false): ChordValidation {
        if (keys.isEmpty()) return ChordValidation(false, "Press at least one key.")
        if (keys.size > 3) return ChordValidation(false, "Shortcut must contain 3 or fewer keys.")
        if (Key.ESCAPE in keys) return ChordValidation(false, "Esc is reserved for cancelling dictation.")
        for ((left, right) in LEFT_TO_RIGHT) {
            if (left in keys && right in keys) {
                return ChordValidation(false, "Shortcut cannot contain both left and right versions of the same key.")
            }
        }
        val canon = canonicalChord(keys, sideSensitive)
        val hasModifier = canon.any { isModifier(it) }
        val standaloneOk = canon.size == 1 && (isFunctionKey(canon[0]) || canon[0] == Key.CAPS_LOCK)
        if (!hasModifier && !standaloneOk) {
            return ChordValidation(false, "Include a modifier key (Ctrl, Alt, Shift, Meta) or use a function key.")
        }
        val set = canonicalChord(keys).toSet()
        for ((combo, action) in BLOCKED) {
            if (combo.size == set.size && combo.all { it in set }) {
                return ChordValidation(false, "${chordLabel(combo)} is reserved by Android: it $action.")
            }
        }
        return ChordValidation(true)
    }
}
