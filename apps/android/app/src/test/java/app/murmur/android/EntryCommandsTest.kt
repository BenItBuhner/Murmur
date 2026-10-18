package app.murmur.android

import android.content.Intent
import app.murmur.android.entry.EntryActions
import app.murmur.android.entry.EntryCommand
import app.murmur.android.entry.EntryCommands
import app.murmur.android.entry.EntryModes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The entry intents every external trigger fires: parsing them and building them back. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EntryCommandsTest {

    @Test
    fun `each action parses to its command`() {
        assertEquals(EntryCommand.Toggle, EntryCommands.parse(Intent(EntryActions.TOGGLE_DICTATION)))
        assertEquals(EntryCommand.Start(false), EntryCommands.parse(Intent(EntryActions.START_DICTATION)))
        assertEquals(EntryCommand.Stop, EntryCommands.parse(Intent(EntryActions.STOP_DICTATION)))
        assertEquals(EntryCommand.Cancel, EntryCommands.parse(Intent(EntryActions.CANCEL_DICTATION)))
    }

    @Test
    fun `anything else is not ours`() {
        assertNull(EntryCommands.parse(null))
        assertNull(EntryCommands.parse(Intent(Intent.ACTION_MAIN)))
    }

    @Test
    fun `the MODE extra decides hands-free or command`() {
        fun start(mode: String?) = Intent(EntryActions.START_DICTATION).apply { mode?.let { putExtra(EntryModes.EXTRA, it) } }
        assertEquals(EntryCommand.Start(false), EntryCommands.parse(start(null)))
        assertEquals(EntryCommand.Start(false), EntryCommands.parse(start(EntryModes.HANDS_FREE)))
        assertEquals(EntryCommand.Start(true), EntryCommands.parse(start(EntryModes.COMMAND)))
        // An unknown mode is hands-free, never a broken command session.
        assertEquals(EntryCommand.Start(false), EntryCommands.parse(start("turbo")))
    }

    @Test
    fun `a built intent round trips through parse`() {
        val context = RuntimeEnvironment.getApplication()
        val commands = listOf(
            EntryCommand.Toggle,
            EntryCommand.Start(false),
            EntryCommand.Start(true),
            EntryCommand.Stop,
            EntryCommand.Cancel
        )
        for (command in commands) {
            val intent = EntryCommands.buildIntent(context, command)
            assertEquals(command, EntryCommands.parse(intent))
        }
    }

    @Test
    fun `a built intent names the trampoline`() {
        val intent = EntryCommands.buildIntent(RuntimeEnvironment.getApplication(), EntryCommand.Toggle)
        assertEquals(EntryActions.TOGGLE_DICTATION, intent.action)
        assertEquals("app.murmur.android.entry.DictationEntryActivity", intent.component?.className)
        assertEquals("app.murmur.android", intent.component?.packageName)
    }

    @Test
    fun `only command mode carries the extra`() {
        val context = RuntimeEnvironment.getApplication()
        assertNull(EntryCommands.buildIntent(context, EntryCommand.Start(false)).getStringExtra(EntryModes.EXTRA))
        assertNull(EntryCommands.buildIntent(context, EntryCommand.Toggle).getStringExtra(EntryModes.EXTRA))
        assertEquals(
            EntryModes.COMMAND,
            EntryCommands.buildIntent(context, EntryCommand.Start(true)).getStringExtra(EntryModes.EXTRA)
        )
    }

    @Test
    fun `the four actions are the ones the manifest answers`() {
        assertEquals(
            listOf(
                "app.murmur.android.action.TOGGLE_DICTATION",
                "app.murmur.android.action.START_DICTATION",
                "app.murmur.android.action.STOP_DICTATION",
                "app.murmur.android.action.CANCEL_DICTATION"
            ),
            EntryActions.ALL
        )
        for (action in EntryActions.ALL) assertTrue(action.startsWith("app.murmur.android.action."))
        assertEquals("app.murmur.android.extra.MODE", EntryModes.EXTRA)
        assertEquals("hands-free", EntryModes.HANDS_FREE)
        assertEquals("command", EntryModes.COMMAND)
    }
}
