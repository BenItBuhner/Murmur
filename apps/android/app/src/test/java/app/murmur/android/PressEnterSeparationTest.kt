package app.murmur.android

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.text.method.PasswordTransformationMethod
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import android.widget.EditText
import app.murmur.android.service.ENTER_SEPARATION_MS
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.KeyboardInput
import app.murmur.android.service.KeyboardStatus
import app.murmur.android.service.TextInserter
import app.murmur.android.service.WEB_ACTIVATION_SETTLE_MS
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * "Press enter" must never ride in the same write as the dictation. Claude Code over SSH drops a
 * bracketed paste when other bytes follow it in the same read (anthropics/claude-code#91205), and
 * terminal programs that detect pastes by timing take an Enter right behind the text for a newline
 * of the paste. So on every insertion path — keyboard commit, key events, set-text, paste — the
 * text lands first, the editor gets to confirm it where it can, and Enter follows after
 * [ENTER_SEPARATION_MS] as an event of its own.
 *
 * The strategy is driven with a fake connection and the test scheduler's virtual clock: every call
 * is stamped with the instant it was made, and everything sent in one instant is one *frame* — what
 * an SSH client would put into a single write. No frame may hold both text and Enter.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PressEnterSeparationTest {

    private sealed class Sent {
        data class Text(val text: String) : Sent()
        data object Ack : Sent()
        data object Enter : Sent()
    }

    /** Everything that went down the connection, stamped with the virtual clock. */
    private class Wire(private val clock: () -> Long) {
        val sent = ArrayList<Pair<Long, Sent>>()
        fun add(s: Sent) = sent.add(clock() to s)

        /** Frames in order: the events that share an instant, i.e. what one write would carry. */
        fun frames(): List<List<Sent>> = sent.groupBy { it.first }.toSortedMap().values.map { f -> f.map { it.second } }
        fun textAt(): Set<Long> = sent.filter { it.second is Sent.Text }.map { it.first }.toSet()
        fun enterAt(): List<Long> = sent.filter { it.second is Sent.Enter }.map { it.first }
        fun ackAt(): List<Long> = sent.filter { it.second is Sent.Ack }.map { it.first }
    }

    /** The keyboard connection as the strategy sees it, wired to [wire]. */
    private class FakeConnection(
        private val wire: Wire,
        override val prefersKeyEvents: Boolean,
        private val commitResult: Boolean = true,
        private val answers: Boolean = true,
    ) : KeyboardInput {
        override fun commitText(text: String): Boolean {
            if (commitResult) wire.add(Sent.Text(text))
            return commitResult
        }
        override fun sendTextAsKeyEvents(text: String): Boolean {
            // Every character is its own key press, all in the same instant: a burst.
            text.forEach { wire.add(Sent.Text(it.toString())) }
            return true
        }
        override suspend fun awaitDelivered(): Boolean {
            wire.add(Sent.Ack)
            return answers
        }
        override fun pressEnter(): Boolean {
            wire.add(Sent.Enter)
            return true
        }
    }

    /** A real `EditText` whose accessibility actions are stamped on the wire like connection calls. */
    private open class WiredField(view: EditText, private val wire: Wire) : EditTextTarget(view) {
        override fun performAction(action: Int, arguments: Bundle?): Boolean {
            when (action) {
                AccessibilityNodeInfo.ACTION_SET_TEXT ->
                    wire.add(Sent.Text(arguments?.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE).toString()))
                AccessibilityNodeInfo.ACTION_PASTE -> wire.add(Sent.Text("<paste>"))
                AccessibilityAction.ACTION_IME_ENTER.id -> wire.add(Sent.Enter)
            }
            return super.performAction(action, arguments)
        }
    }

    private lateinit var activity: Activity
    private lateinit var field: EditText

    @Before
    fun setUp() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())
    }

    /** The real clipboard, so a paste into the field has something to paste. */
    private fun toClipboard(text: String) {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    private fun TestScope.wire() = Wire { testScheduler.currentTime }

    /** The invariant: text and Enter are in different frames, Enter's after the text's, and only one Enter. */
    private fun assertSeparated(wire: Wire, delay: Long = ENTER_SEPARATION_MS) {
        val frames = wire.frames()
        assertTrue("something was sent", frames.isNotEmpty())
        for (frame in frames) {
            val mixed = frame.any { it is Sent.Text } && frame.any { it is Sent.Enter }
            assertTrue("text and Enter share a frame: $frame", !mixed)
        }
        val lastText = wire.textAt().max()
        assertEquals("exactly one Enter", 1, wire.enterAt().size)
        val enter = wire.enterAt().single()
        assertTrue("Enter ($enter) is not later than the text ($lastText)", enter > lastText)
        assertEquals("Enter follows the text by the pause", lastText + delay, enter)
    }

    // ---- keyboard connection: commit, key events ----------------------------------------------

    @Test
    fun `committed text and Enter never share a frame`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = false)

        val outcome = TextInserter.insert(
            target = null, text = "git status", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard"), outcome)
        assertSeparated(wire)
        assertEquals(listOf(listOf(Sent.Text("git status"), Sent.Ack), listOf(Sent.Enter)), wire.frames())
    }

    @Test
    fun `a burst of key events and Enter never share a frame`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = true)

        val outcome = TextInserter.insert(
            target = null, text = "make", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertSeparated(wire)
        // The keys go out as one burst — exactly what a paste-burst detector looks at — and Enter
        // only after that burst is over.
        assertEquals(listOf("m", "a", "k", "e"), wire.frames().first().filterIsInstance<Sent.Text>().map { it.text })
        assertEquals(listOf(Sent.Enter), wire.frames().last())
    }

    @Test
    fun `the editor is asked to confirm the text before the pause starts`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = false)

        TextInserter.insert(
            target = null, text = "ls", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals("asked right after the text, before any time passes", listOf(0L), wire.ackAt())
        assertEquals(listOf(ENTER_SEPARATION_MS), wire.enterAt())
    }

    @Test
    fun `an editor that does not confirm the text still gets its Enter after the pause`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = false, answers = false)

        TextInserter.insert(
            target = null, text = "ls", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertSeparated(wire)
    }

    @Test
    fun `a commit the editor ignores is typed as keys, and Enter still waits`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = false, commitResult = false)

        val outcome = TextInserter.insert(
            target = null, text = "ls", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertSeparated(wire)
    }

    @Test
    fun `the pause is configurable`() = runTest {
        val wire = wire()
        val connection = FakeConnection(wire, prefersKeyEvents = false)

        TextInserter.insert(
            target = null, text = "ls", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE, enterDelayMs = 40
        )

        assertSeparated(wire, delay = 40)
    }

    @Test
    fun `without press enter nothing is asked, nothing waits and no Enter is sent`() = runTest {
        for (prefersKeyEvents in listOf(false, true)) {
            val wire = wire()
            val connection = FakeConnection(wire, prefersKeyEvents = prefersKeyEvents)
            val before = testScheduler.currentTime

            TextInserter.insert(
                target = null, text = "git status", pressEnter = false, toClipboard = {},
                keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
            )

            assertEquals("no time passes for a dictation that does not press Enter", before, testScheduler.currentTime)
            assertTrue(wire.ackAt().isEmpty())
            assertTrue(wire.enterAt().isEmpty())
        }
    }

    // ---- accessibility node: set-text, paste ----------------------------------------------------

    @Test
    fun `set-text and the IME Enter action never share a frame`() = runTest {
        val wire = wire()
        val target = WiredField(field, wire)
        val connection = FakeConnection(wire, prefersKeyEvents = false)

        val outcome = TextInserter.insert(
            target = target, text = "Hello world", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("set-text"), outcome)
        assertEquals("Hello world", field.text.toString())
        assertSeparated(wire)
        // A node action returns once the field has acted on it, so no separate confirmation is asked
        // for, and Enter goes to the node, not the keyboard connection.
        assertTrue(wire.ackAt().isEmpty())
        assertEquals(listOf(listOf<Sent>(Sent.Text("Hello world")), listOf(Sent.Enter)), wire.frames())
    }

    @Test
    fun `a paste into web content and the IME Enter action never share a frame`() = runTest {
        val wire = wire()
        val web = object : WiredField(field, wire) {
            override val isWebContent: Boolean get() = true
        }

        val outcome = TextInserter.insert(web, "Hello world", pressEnter = true, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals("Hello world", field.text.toString())
        assertSeparated(wire)
        // The paste itself waits for the activation click to settle; Enter waits its own pause after it.
        assertEquals(setOf(WEB_ACTIVATION_SETTLE_MS), wire.textAt())
        assertEquals(listOf(WEB_ACTIVATION_SETTLE_MS + ENTER_SEPARATION_MS), wire.enterAt())
    }

    @Test
    fun `a paste into a password field and the IME Enter action never share a frame`() = runTest {
        field.transformationMethod = PasswordTransformationMethod.getInstance()
        val wire = wire()
        val password = WiredField(field, wire)

        val outcome = TextInserter.insert(password, "secret", pressEnter = true, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals("secret", field.text.toString())
        assertSeparated(wire)
    }

    @Test
    fun `a field that refuses set-text is pasted into, and Enter still waits`() = runTest {
        val wire = wire()
        val refusesSetText = object : WiredField(field, wire) {
            override fun performAction(action: Int, arguments: Bundle?): Boolean =
                action != AccessibilityNodeInfo.ACTION_SET_TEXT && super.performAction(action, arguments)
        }

        val outcome = TextInserter.insert(refusesSetText, "Hello", pressEnter = true, ::toClipboard)

        assertEquals(InsertOutcome.Inserted("paste"), outcome)
        assertEquals("Hello", field.text.toString())
        assertSeparated(wire)
    }

    @Test
    fun `a node without an IME Enter action gets Enter through the keyboard connection, after the pause`() = runTest {
        val wire = wire()
        // A focused node that is not a text field; the connection underneath it is the editor.
        val notAField = object : WiredField(field, wire) {
            override val isEditable: Boolean get() = false
        }
        val connection = FakeConnection(wire, prefersKeyEvents = true)

        val outcome = TextInserter.insert(
            target = notAField, text = "make", pressEnter = true, toClipboard = {},
            keyboard = connection, keyboardStatus = KeyboardStatus.AVAILABLE
        )

        assertEquals(InsertOutcome.Inserted("keyboard-keys"), outcome)
        assertSeparated(wire)
        assertEquals(listOf(0L), wire.ackAt())
    }

    @Test
    fun `node paths do not wait either when Enter is not pressed`() = runTest {
        val wire = wire()

        TextInserter.insert(WiredField(field, wire), "Hello world ", pressEnter = false, toClipboard = {})

        assertEquals("Hello world ", field.text.toString())
        assertEquals(0L, testScheduler.currentTime)
        assertTrue(wire.enterAt().isEmpty())
    }
}
