package app.murmur.android

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.KeyboardInput
import app.murmur.android.service.KeyboardStatus
import app.murmur.android.service.TextInserter
import app.murmur.android.service.acceptsText
import app.murmur.android.service.typeAsKeys
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The terminal case, end to end against a real `View`. [TerminalLikeView] is exactly the shape a
 * terminal emulator (Termux, ConnectBot) presents: it declares itself a text editor and builds an
 * [InputConnection] from `onCreateInputConnection` with `inputType = TYPE_NULL`, but it exposes no
 * editable accessibility node. It reads keys the way Termux's `TerminalView.onKeyDown` does, through
 * the phone's virtual keyboard map ([DeviceKeyMap]), with Left Alt sent as an Escape prefix. The
 * strategy is driven with [ConnectionKeyboard], which forwards commits and key events to that
 * connection the same way the platform's `InputMethod.AccessibilityInputConnection` forwards them
 * to the served view, typing through the production [typeAsKeys] — so this proves the mechanism the
 * real keyboard-support path relies on, without an Android 13 device.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TerminalViewInsertionTest {

    /** A custom view that takes key input like a terminal and keeps what it received. */
    private class TerminalLikeView(context: Context) : View(context) {
        val buffer = StringBuilder()
        /** Text that arrived through `commitText` rather than as key presses, in order. */
        val committed = ArrayList<String>()
        private val keys = DeviceKeyMap()
        init {
            isFocusable = true
            isFocusableInTouchMode = true
        }
        override fun onCheckIsTextEditor(): Boolean = true
        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
            // A terminal asks for the raw key stream, not composed text.
            outAttrs.inputType = InputType.TYPE_NULL
            outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
            return object : BaseInputConnection(this, false) {
                override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                    committed.add(text.toString())
                    buffer.append(text)
                    return true
                }
                override fun sendKeyEvent(event: KeyEvent): Boolean {
                    onTerminalKey(event)
                    return true
                }
            }
        }

        private fun onTerminalKey(event: KeyEvent) {
            if (event.action != KeyEvent.ACTION_DOWN) return
            if (event.keyCode == KeyEvent.KEYCODE_ENTER) {
                buffer.append('\n')
                return
            }
            val leftAlt = event.metaState and KeyEvent.META_ALT_LEFT_ON != 0
            val meta = event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON).inv()
            val ch = keys.charFor(event.keyCode, meta)
            if (ch == 0) return
            if (leftAlt) buffer.append('\u001b')
            buffer.appendCodePoint(ch)
        }
    }

    /** [KeyboardInput] over a plain [InputConnection]; the production one wraps the a11y connection. */
    private class ConnectionKeyboard(
        private val connection: InputConnection,
        editorInfo: EditorInfo,
    ) : KeyboardInput {
        override val prefersKeyEvents: Boolean = editorInfo.inputType == InputType.TYPE_NULL
        override fun commitText(text: String): Boolean = connection.commitText(text, 1)
        override fun sendTextAsKeyEvents(text: String): Boolean {
            typeAsKeys(text, DeviceKeyMap(), sendKey = { connection.sendKeyEvent(it) }, commit = { connection.commitText(it, 1) })
            return true
        }
        override fun pressEnter(): Boolean {
            connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
            return true
        }
    }

    private fun terminal(): Pair<TerminalLikeView, ConnectionKeyboard> {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val view = TerminalLikeView(activity)
        activity.setContentView(view)
        assertTrue(view.requestFocus())
        val editorInfo = EditorInfo()
        val connection = view.onCreateInputConnection(editorInfo)!!
        return view to ConnectionKeyboard(connection, editorInfo)
    }

    @Test
    fun `the terminal view exposes no editable accessibility node`() {
        val (view, _) = terminal()
        val node = AccessibilityNodeInfo.obtain()
        view.onInitializeAccessibilityNodeInfo(node)

        // This is the root cause: the node route has nothing to act on for a terminal.
        assertFalse("a terminal view is not an editable node", node.isEditable)
        assertFalse(node.acceptsText())
    }

    @Test
    fun `dictation lands in the terminal through the keyboard connection`() = runTest {
        val (view, keyboard) = terminal()

        val outcome = TextInserter.insert(
            target = null, text = "git status", pressEnter = false, toClipboard = {},
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertTrue("inserted, not copied: $outcome", outcome is InsertOutcome.Inserted)
        assertEquals("git status", view.buffer.toString())
    }

    @Test
    fun `press enter runs the command in the terminal`() = runTest {
        val (view, keyboard) = terminal()

        TextInserter.insert(
            target = null, text = "make", pressEnter = true, toClipboard = {},
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals("make\n", view.buffer.toString())
    }

    @Test
    fun `with keyboard support off the same terminal falls back to the clipboard`() = runTest {
        val (view, _) = terminal()
        val clipboard = ArrayList<String>()

        val outcome = TextInserter.insert(
            target = null, text = "git status", pressEnter = false, toClipboard = { clipboard.add(it) },
            keyboard = null, keyboardStatus = KeyboardStatus.OFF_BUT_EDITOR_PRESENT
        )

        assertTrue(outcome is InsertOutcome.Failed)
        assertEquals(listOf("git status"), clipboard)
        assertEquals("nothing typed into the terminal without keyboard support", "", view.buffer.toString())
    }

    private suspend fun dictate(text: String): Pair<TerminalLikeView, InsertOutcome> {
        val (view, keyboard) = terminal()
        val outcome = TextInserter.insert(
            target = null, text = text, pressEnter = false, toClipboard = {},
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )
        return view to outcome
    }

    @Test
    fun `dictated contractions land in the terminal letter for letter`() = runTest {
        val text = "What are you referring to? I don't recall, it's fine, we'll see, Bennett's phone. "
        val (view, outcome) = dictate(text)

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(text, view.buffer.toString())
        assertTrue("typed as keys, nothing committed: ${view.committed}", view.committed.isEmpty())
    }

    @Test
    fun `typographic apostrophes and quotes land in the terminal without taking the rest off the key stream`() = runTest {
        val text = "I don’t recall, it’s ‘fine’ — “really”… \"ok\" "
        val (view, outcome) = dictate(text)

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(text, view.buffer.toString())
        assertEquals("only the marks no key produces are committed", listOf("’", "’", "‘", "’", "—", "“", "”…"), view.committed)
    }

    @Test
    fun `accented letters land in the terminal instead of Escape sequences`() = runTest {
        val text = "Ça va, garçon? A cafe\u0301 in the Straße. "
        val (view, outcome) = dictate(text)

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(text, view.buffer.toString())
        assertTrue("no Escape reached the terminal", '\u001b' !in view.buffer)
    }
}
