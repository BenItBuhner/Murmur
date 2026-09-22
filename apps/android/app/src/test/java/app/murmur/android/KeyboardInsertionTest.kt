package app.murmur.android

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.text.InputType
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import app.murmur.android.service.COPIED_EDITOR_REJECTED
import app.murmur.android.service.COPIED_ENABLE_KEYBOARD
import app.murmur.android.service.COPIED_KEYBOARD_FAILED
import app.murmur.android.service.COPIED_KEYBOARD_UNSUPPORTED
import app.murmur.android.service.COPIED_NO_CONNECTION
import app.murmur.android.service.COPIED_NO_FIELD
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.KeyboardInput
import app.murmur.android.service.KeyboardStatus
import app.murmur.android.service.TextInserter
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The keyboard-support side of insertion: the Android 13+ input-method connection that reaches
 * editors with no editable accessibility node — terminals above all — and the failure notices that
 * name which step went wrong. [TextInserter] is driven with a fake [KeyboardInput] (the real one
 * wraps `InputMethod.AccessibilityInputConnection`, which no unit-test framework can stand up) and,
 * for the field cases, a real `EditText` through the same path the other insertion tests use.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyboardInsertionTest {

    private lateinit var activity: Activity
    private lateinit var field: EditText
    private val clipboard = ArrayList<String>()

    private fun toClipboard(text: String) {
        clipboard.add(text)
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    /** Records the connection calls the strategy makes and answers them however the test wants. */
    private class FakeKeyboard(
        override val prefersKeyEvents: Boolean = false,
        private val commitResult: Boolean = true,
        private val keyResult: Boolean = true,
    ) : KeyboardInput {
        val committed = ArrayList<String>()
        val keyed = ArrayList<String>()
        var enterPresses = 0
        var deliveryChecks = 0
        override fun commitText(text: String): Boolean {
            committed.add(text)
            return commitResult
        }
        override fun sendTextAsKeyEvents(text: String): Boolean {
            keyed.add(text)
            return keyResult
        }
        override suspend fun awaitDelivered(): Boolean {
            deliveryChecks++
            return true
        }
        override fun pressEnter(): Boolean {
            enterPresses++
            return true
        }
    }

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())
    }

    // ---- terminal-style: no editable node, only an input connection ------------------------

    @Test
    fun `a terminal with a TYPE_NULL editor is typed with key events`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = true)

        val outcome = TextInserter.insert(
            target = null, text = "git status", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(listOf("git status"), keyboard.keyed)
        assertTrue("a TYPE_NULL editor is never committed into", keyboard.committed.isEmpty())
        assertTrue("nothing is copied when the text lands", clipboard.isEmpty())
    }

    @Test
    fun `a terminal editor that takes committed text is committed into`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = false)

        val outcome = TextInserter.insert(
            target = null, text = "hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard"), outcome)
        assertEquals(listOf("hello"), keyboard.committed)
        assertTrue(keyboard.keyed.isEmpty())
        assertTrue(clipboard.isEmpty())
    }

    @Test
    fun `a commit the editor ignores falls back to key events`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = false, commitResult = false, keyResult = true)

        val outcome = TextInserter.insert(
            target = null, text = "ls -la", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(listOf("ls -la"), keyboard.committed)
        assertEquals(listOf("ls -la"), keyboard.keyed)
    }

    @Test
    fun `press enter in a terminal goes through the keyboard connection`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = true)

        TextInserter.insert(
            target = null, text = "make", pressEnter = true, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals("Enter is sent to the terminal", 1, keyboard.enterPresses)
        assertEquals(listOf("make"), keyboard.keyed)
        assertEquals("the editor is asked to confirm the text before Enter", 1, keyboard.deliveryChecks)
    }

    @Test
    fun `a dictation without press enter neither waits for the editor nor pauses`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = false)

        TextInserter.insert(
            target = null, text = "hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(0, keyboard.deliveryChecks)
        assertEquals(0, keyboard.enterPresses)
        assertEquals("no time passes: the Enter pause is only paid by dictations that press it", 0L, testScheduler.currentTime)
    }

    @Test
    fun `a focused non-text view is typed through the keyboard when a connection exists`() = runTest {
        // A node is focused but is not a text field (no editable flag, no text actions): only the
        // input connection can reach a real editor.
        val notAField = object : EditTextTarget(field) {
            override val isEditable: Boolean get() = false
        }
        val keyboard = FakeKeyboard(prefersKeyEvents = true)

        val outcome = TextInserter.insert(
            target = notAField, text = "echo hi", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertEquals(listOf("echo hi"), keyboard.keyed)
    }

    // ---- editable fields keep the node path; keyboard is only a fallback -------------------

    @Test
    fun `an editable field is written with set-text even when keyboard support is on`() = runTest {
        val keyboard = FakeKeyboard()

        val outcome = TextInserter.insert(
            target = EditTextTarget(field), text = "Hello world ", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello world ", field.text.toString())
        assertTrue("the keyboard connection is left alone for a normal field", keyboard.committed.isEmpty() && keyboard.keyed.isEmpty())
    }

    @Test
    fun `a field that refuses set-text uses the keyboard before pasting`() = runTest {
        val performed = ArrayList<Int>()
        val refusesSetText = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean {
                performed.add(action)
                return if (action == AccessibilityNodeInfo.ACTION_SET_TEXT) false
                else super.performAction(action, arguments)
            }
        }
        val keyboard = FakeKeyboard(prefersKeyEvents = false)

        val outcome = TextInserter.insert(
            target = refusesSetText, text = "world", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard"), outcome)
        assertEquals(listOf("world"), keyboard.committed)
        assertFalse("paste is never reached once the keyboard takes the text", performed.contains(AccessibilityNodeInfo.ACTION_PASTE))
        assertTrue(clipboard.isEmpty())
    }

    // ---- failure notices name the step that failed -----------------------------------------

    @Test
    fun `no editor and keyboard support off reports the plain no-field notice`() = runTest {
        val outcome = TextInserter.insert(
            target = null, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = null, keyboardStatus = KeyboardStatus.OFF
        )

        assertEquals(InsertOutcome.Failed(COPIED_NO_FIELD), outcome)
        assertEquals(listOf("Hello"), clipboard)
    }

    @Test
    fun `an editor with keyboard support off suggests turning it on`() = runTest {
        val outcome = TextInserter.insert(
            target = null, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = null, keyboardStatus = KeyboardStatus.OFF_BUT_EDITOR_PRESENT
        )

        assertEquals(InsertOutcome.Failed(COPIED_ENABLE_KEYBOARD), outcome)
        assertEquals(listOf("Hello"), clipboard)
    }

    @Test
    fun `keyboard support on with no connection asks to re-enable the service`() = runTest {
        val outcome = TextInserter.insert(
            target = null, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = null, keyboardStatus = KeyboardStatus.NO_CONNECTION
        )

        assertEquals(InsertOutcome.Failed(COPIED_NO_CONNECTION), outcome)
    }

    @Test
    fun `keyboard support on an older android is reported unsupported`() = runTest {
        val outcome = TextInserter.insert(
            target = null, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = null, keyboardStatus = KeyboardStatus.UNSUPPORTED
        )

        assertEquals(InsertOutcome.Failed(COPIED_KEYBOARD_UNSUPPORTED), outcome)
    }

    @Test
    fun `a connected keyboard that cannot type anything reports the keyboard failed`() = runTest {
        val keyboard = FakeKeyboard(prefersKeyEvents = false, commitResult = false, keyResult = false)

        val outcome = TextInserter.insert(
            target = null, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Failed(COPIED_KEYBOARD_FAILED), outcome)
        assertEquals(listOf("Hello"), clipboard)
    }

    @Test
    fun `a text field that refuses everything with the keyboard on reports the editor rejected it`() = runTest {
        val blocked = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean = false
        }
        val keyboard = FakeKeyboard(prefersKeyEvents = false, commitResult = false, keyResult = false)

        val outcome = TextInserter.insert(
            target = blocked, text = "Hello", pressEnter = false, toClipboard = ::toClipboard,
            keyboard = keyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Failed(COPIED_EDITOR_REJECTED), outcome)
        assertEquals(listOf("Hello"), clipboard)
    }

    // ---- every apostrophe, quote and accent reaches a normal field intact ------------------

    private val punctuated = "I don't recall, it’s ‘fine’ — “really”… \"ok\", café, cafe\u0301, garçon, Straße \uD83D\uDE80 "

    @Test
    fun `apostrophes, quotes and accents survive set-text`() = runTest {
        val outcome = TextInserter.insert(
            target = EditTextTarget(field), text = punctuated, pressEnter = false, toClipboard = ::toClipboard,
            keyboard = FakeKeyboard(), keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals(punctuated, field.text.toString())
    }

    @Test
    fun `apostrophes, quotes and accents survive a keyboard commit into a normal field`() = runTest {
        val editorInfo = EditorInfo()
        val connection = field.onCreateInputConnection(editorInfo)!!
        val fieldKeyboard = object : KeyboardInput {
            override val prefersKeyEvents: Boolean = editorInfo.inputType == InputType.TYPE_NULL
            override fun commitText(text: String): Boolean = connection.commitText(text, 1)
            override fun sendTextAsKeyEvents(text: String): Boolean = false
            override suspend fun awaitDelivered(): Boolean = connection.getSurroundingText(0, 0, 0) != null
            override fun pressEnter(): Boolean = false
        }
        val refusesSetText = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean =
                action != AccessibilityNodeInfo.ACTION_SET_TEXT && super.performAction(action, arguments)
        }

        val outcome = TextInserter.insert(
            target = refusesSetText, text = punctuated, pressEnter = false, toClipboard = ::toClipboard,
            keyboard = fieldKeyboard, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard"), outcome)
        assertEquals(punctuated, field.text.toString())
    }

    @Test
    fun `apostrophes, quotes and accents survive paste`() = runTest {
        val refusesSetText = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean =
                action != AccessibilityNodeInfo.ACTION_SET_TEXT && super.performAction(action, arguments)
        }

        val outcome = TextInserter.insert(
            target = refusesSetText, text = punctuated, pressEnter = false, toClipboard = ::toClipboard,
            keyboard = null, keyboardStatus = KeyboardStatus.OFF
        )

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals(listOf(punctuated), clipboard)
        assertEquals(punctuated, field.text.toString())
    }
}
