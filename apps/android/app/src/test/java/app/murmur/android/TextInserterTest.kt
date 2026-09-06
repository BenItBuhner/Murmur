package app.murmur.android

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.text.method.PasswordTransformationMethod
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import app.murmur.android.service.COPIED_FIELD_BLOCKED
import app.murmur.android.service.COPIED_NO_FIELD
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.TextInserter
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
 * Drives [TextInserter] against a real `EditText` through `View.performAccessibilityAction`, the
 * same framework entry point an accessibility service's `AccessibilityNodeInfo.performAction`
 * ends up in inside the target app. Nothing about SET_TEXT / SET_SELECTION / PASTE is mocked.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TextInserterTest {

    private lateinit var activity: Activity
    private lateinit var field: EditText
    private val clipboard = ArrayList<String>()

    private fun toClipboard(text: String) {
        clipboard.add(text)
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())
    }

    @Test
    fun `framework empties the field on SET_TEXT without a text argument (the old caret move)`() {
        field.setText("Hello world ")
        val selectionOnly = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 12)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 12)
        }
        // This is what the service used to send right after inserting: it "succeeds"...
        assertTrue(field.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_TEXT, selectionOnly))
        // ...and wipes the dictation, leaving the hint showing again.
        assertEquals("", field.text.toString())
    }

    @Test
    fun `inserts into an empty field without dragging the hint along`() {
        val outcome = TextInserter.insert(EditTextTarget(field), "Hello world ", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello world ", field.text.toString())
        assertEquals(12, field.selectionStart)
        assertEquals(12, field.selectionEnd)
        assertTrue(clipboard.isEmpty())
    }

    @Test
    fun `text survives and the caret lands right after the dictation`() {
        field.setText("Hello  friend")
        field.setSelection(6)

        val outcome = TextInserter.insert(EditTextTarget(field), "there", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello there friend", field.text.toString())
        assertEquals("Hello there".length, field.selectionStart)
        assertEquals("Hello there".length, field.selectionEnd)
    }

    @Test
    fun `replaces the selected range`() {
        field.setText("Send it Tuesday")
        field.setSelection(8, 15)

        TextInserter.insert(EditTextTarget(field), "Wednesday", pressEnter = false, ::toClipboard)

        assertEquals("Send it Wednesday", field.text.toString())
        assertEquals(17, field.selectionStart)
        assertEquals(17, field.selectionEnd)
    }

    @Test
    fun `consecutive dictations append in order`() {
        val target = EditTextTarget(field)
        TextInserter.insert(target, "First sentence. ", pressEnter = false, ::toClipboard)
        TextInserter.insert(target, "Second sentence. ", pressEnter = false, ::toClipboard)

        assertEquals("First sentence. Second sentence. ", field.text.toString())
        assertEquals(field.text.length, field.selectionStart)
    }

    @Test
    fun `falls back to clipboard paste when the field refuses SET_TEXT`() {
        field.setText("Hello ")
        field.setSelection(6)
        val refusing = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean =
                if (action == AccessibilityNodeInfo.ACTION_SET_TEXT) false
                else super.performAction(action, arguments)
        }

        val outcome = TextInserter.insert(refusing, "world", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals(listOf("world"), clipboard)
        assertEquals("Hello world", field.text.toString())
    }

    @Test
    fun `web content is pasted into and never rewritten with SET_TEXT`() {
        field.setText("Hello ")
        field.setSelection(6)
        val performed = ArrayList<Int>()
        // Chromium reports a page's contenteditable editor as an editable EditText whose text is
        // the placeholder-laden subtree; SET_TEXT would "succeed" and wipe the editor's state.
        val web = object : EditTextTarget(field) {
            override val isWebContent: Boolean get() = true
            override fun performAction(action: Int, arguments: Bundle?): Boolean {
                performed.add(action)
                return super.performAction(action, arguments)
            }
        }

        val outcome = TextInserter.insert(web, "world", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals(listOf("world"), clipboard)
        assertEquals("Hello world", field.text.toString())
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_PASTE), performed)
    }

    @Test
    fun `web content whose engine refuses to paste is written with SET_TEXT`() {
        field.setText("Hello ")
        field.setSelection(6)
        val noPaste = object : EditTextTarget(field) {
            override val isWebContent: Boolean get() = true
            override fun performAction(action: Int, arguments: Bundle?): Boolean =
                if (action == AccessibilityNodeInfo.ACTION_PASTE) false
                else super.performAction(action, arguments)
        }

        val outcome = TextInserter.insert(noPaste, "world", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello world", field.text.toString())
        assertEquals(11, field.selectionStart)
    }

    @Test
    fun `a field that only advertises PASTE is pasted into`() {
        field.setText("Hello ")
        field.setSelection(6)
        val performed = ArrayList<Int>()
        val pasteOnly = object : EditTextTarget(field) {
            override val isEditable: Boolean get() = false
            override fun supportsAction(action: Int): Boolean = action == AccessibilityNodeInfo.ACTION_PASTE
            override fun performAction(action: Int, arguments: Bundle?): Boolean {
                performed.add(action)
                return super.performAction(action, arguments)
            }
        }

        val outcome = TextInserter.insert(pasteOnly, "world", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals("Hello world", field.text.toString())
        assertEquals(listOf(AccessibilityNodeInfo.ACTION_PASTE), performed)
    }

    @Test
    fun `a field that only advertises SET_TEXT is written with SET_TEXT`() {
        val setTextOnly = object : EditTextTarget(field) {
            override val isEditable: Boolean get() = false
            override fun supportsAction(action: Int): Boolean = action == AccessibilityNodeInfo.ACTION_SET_TEXT
        }

        val outcome = TextInserter.insert(setTextOnly, "Hello world ", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello world ", field.text.toString())
        assertTrue(clipboard.isEmpty())
    }

    @Test
    fun `password fields are pasted into, never rewritten from their masked text`() {
        field.transformationMethod = PasswordTransformationMethod.getInstance()
        field.setText("secret")
        field.setSelection(6)

        val outcome = TextInserter.insert(EditTextTarget(field), "123", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals("secret123", field.text.toString())
    }

    @Test
    fun `reports copied when nothing editable is focused`() {
        val readOnly = object : EditTextTarget(field) {
            override val isEditable: Boolean get() = false
        }

        val outcome = TextInserter.insert(readOnly, "Hello", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Failed(COPIED_NO_FIELD), outcome)
        assertEquals(listOf("Hello"), clipboard)
        assertEquals("", field.text.toString())
    }

    @Test
    fun `reports copied when both SET_TEXT and PASTE are refused`() {
        val blocked = object : EditTextTarget(field) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean = false
        }

        val outcome = TextInserter.insert(blocked, "Hello", pressEnter = false, ::toClipboard)

        assertEquals(InsertOutcome.Failed(COPIED_FIELD_BLOCKED), outcome)
        assertEquals(listOf("Hello"), clipboard)
        assertFalse(field.text.toString().contains("Hello"))
    }
}
