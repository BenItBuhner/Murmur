package app.murmur.android

import android.view.KeyCharacterMap
import android.view.KeyEvent
import app.murmur.android.service.KeyMap
import app.murmur.android.service.VirtualKeyMap
import app.murmur.android.service.typeAsKeys
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * How a dictation is typed into an editor that reads the key stream (a terminal's TYPE_NULL view),
 * against the phone's own virtual keyboard map ([DeviceKeyMap]). Plain keys, alone or with Shift,
 * type what they can; everything else is committed as text in its place and nothing is lost.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyTypingTest {

    private val keys = DeviceKeyMap()

    /** One thing the editor received: a key press (down/up and any modifier presses) or committed text. */
    private sealed class Sent {
        data class Key(val event: KeyEvent) : Sent()
        data class Text(val text: String) : Sent()
    }

    private fun type(text: String, map: KeyMap = keys): List<Sent> {
        val sent = ArrayList<Sent>()
        typeAsKeys(text, map, sendKey = { sent.add(Sent.Key(it)) }, commit = { sent.add(Sent.Text(it)) })
        return sent
    }

    /** What lands on screen: each typed key read back through the device map, commits verbatim. */
    private fun rendered(sent: List<Sent>, map: KeyMap = keys): String = buildString {
        for (s in sent) when (s) {
            is Sent.Text -> append(s.text)
            is Sent.Key -> {
                val e = s.event
                if (e.action != KeyEvent.ACTION_DOWN || KeyEvent.isModifierKey(e.keyCode)) continue
                val ch = map.charFor(e.keyCode, e.metaState)
                assertFalse("a dead key reached the editor: $e", ch and KeyCharacterMap.COMBINING_ACCENT != 0)
                appendCodePoint(ch)
            }
        }
    }

    private fun commits(sent: List<Sent>) = sent.filterIsInstance<Sent.Text>().map { it.text }
    private fun keyEvents(sent: List<Sent>) = sent.filterIsInstance<Sent.Key>().map { it.event }

    @Test
    fun `ASCII contractions are typed entirely as plain key presses`() {
        val text = "I don't recall, it's fine, we'll see, Bennett's phone. \"Quoted\" too?"
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertTrue("nothing is committed: ${commits(sent)}", commits(sent).isEmpty())
        val apostrophes = keyEvents(sent).filter { it.keyCode == KeyEvent.KEYCODE_APOSTROPHE && it.action == KeyEvent.ACTION_DOWN }
        assertEquals("four apostrophes and two Shift+apostrophe quotes", 6, apostrophes.size)
    }

    @Test
    fun `a typographic apostrophe is committed in place and the rest stays on the key stream`() {
        val text = "I don’t recall, it’s fine, we’ll see."
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("’", "’", "’"), commits(sent))
        // The letter after each apostrophe is a key press of its own, right after the commit.
        val afterFirst = sent[sent.indexOfFirst { it is Sent.Text } + 1] as Sent.Key
        assertEquals(KeyEvent.KEYCODE_T, afterFirst.event.keyCode)
    }

    @Test
    fun `opening and closing typographic quotes are committed, straight quotes are typed`() {
        val text = "He said ‘fine’ and “it’s done” and \"ok\"."
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("‘", "’", "“", "’", "”"), commits(sent))
    }

    @Test
    fun `dashes, ellipses and accented letters are committed as the runs they form`() {
        val text = "Wait — really…… a café in Zürich, naïve señor."
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("—", "……", "é", "ü", "ï", "ñ"), commits(sent))
    }

    @Test
    fun `letters the map only reaches through Alt are committed, never sent as Alt chords`() {
        val text = "Ça va, garçon? Straße."
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("Ç", "ç", "ß"), commits(sent))
        assertTrue(
            "no Alt press reaches the editor",
            keyEvents(sent).none { it.keyCode == KeyEvent.KEYCODE_ALT_LEFT || it.metaState and KeyEvent.META_ALT_ON != 0 },
        )
    }

    @Test
    fun `a combining accent is committed with its letter, never sent as a dead key`() {
        val text = "cafe\u0301 don't"
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("e\u0301"), commits(sent))
    }

    @Test
    fun `emoji and other supplementary characters are committed whole`() {
        val text = "ship it \uD83D\uDE80 now"
        val sent = type(text)

        assertEquals(text, rendered(sent))
        assertEquals(listOf("\uD83D\uDE80"), commits(sent))
    }

    @Test
    fun `without a key map the whole dictation is committed once`() {
        val text = "I don’t recall."
        val sent = type(text, VirtualKeyMap(null))

        assertEquals(listOf(text), commits(sent))
        assertTrue(keyEvents(sent).isEmpty())
    }
}
