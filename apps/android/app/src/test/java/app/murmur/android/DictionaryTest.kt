package app.murmur.android

import app.murmur.android.settings.DictionaryCodec
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.text.applyDictionary
import app.murmur.android.text.editDistance
import app.murmur.android.text.AppCategory
import app.murmur.android.text.basicCleanup
import app.murmur.android.text.finish
import app.murmur.android.text.soundKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors apps/desktop/tests/text-pipeline.test.ts for the dictionary stage. */
class DictionaryTest {
    private val wispr = DictionaryEntry("1", "Wispr Flow", listOf("whisper flow", "wisper flow"), fuzzy = true)
    private val convex = DictionaryEntry("2", "Convex", emptyList(), fuzzy = false)

    @Test
    fun `aliases and case variants become the canonical spelling`() {
        assertEquals(
            "send it to Wispr Flow support and Wispr Flow sales",
            applyDictionary("send it to whisper flow support and WISPER FLOW sales", listOf(wispr))
        )
        assertEquals("we use Convex here", applyDictionary("we use convex here", listOf(convex)))
    }

    @Test
    fun `never guesses a dictionary word from a sound-alike, the model reads the list instead`() {
        val bennett = DictionaryEntry("3", "Bennett", emptyList(), fuzzy = true)
        val entries = listOf(wispr.copy(aliases = emptyList()), convex.copy(fuzzy = true), bennett)
        val text = "a Konvex lens, a whisper flow of air, and Bennet from accounts"
        assertEquals(text, applyDictionary(text, entries))
    }

    @Test
    fun `does not touch unrelated words or substrings`() {
        assertEquals("convexity", applyDictionary("convexity", listOf(convex)))
        assertEquals("hello", applyDictionary("hello", listOf(convex)))
        assertEquals("", applyDictionary("", listOf(convex)))
    }

    @Test
    fun `corrects an entry inside its possessive, with either apostrophe`() {
        val bennett = DictionaryEntry("3", "Bennett", listOf("bennet"), fuzzy = true)
        assertEquals("that is Bennett's phone", applyDictionary("that is bennet's phone", listOf(bennett)))
        assertEquals("that is Bennett’s phone", applyDictionary("that is bennet’s phone", listOf(bennett)))
        assertEquals("Bennett's phone rang", applyDictionary("Bennet's phone rang", listOf(bennett)))
        assertEquals("Wispr Flow's new build", applyDictionary("whisper flow's new build", listOf(wispr)))
        // A plural possessive keeps its apostrophe, whether the word was corrected or already right.
        val bennetts = DictionaryEntry("4", "Bennetts", listOf("bennets"))
        assertEquals("the Bennetts' house", applyDictionary("the bennets' house", listOf(bennetts)))
        assertEquals("the Bennetts’ house", applyDictionary("the bennets’ house", listOf(bennetts)))
        assertEquals("the Bennetts' house", applyDictionary("the Bennetts' house", listOf(bennetts)))
        // A singular alias does not reach into a plural possessive.
        assertEquals("the bennets' house", applyDictionary("the bennets' house", listOf(bennett)))
        // Punctuation after the word is never swallowed by a correction.
        assertEquals("call it 'Bennett' for now", applyDictionary("call it 'Bennet' for now", listOf(bennett)))
        assertEquals("the Bennett-smith account", applyDictionary("the bennet-smith account", listOf(bennett)))
        // Underscore continues a word: an identifier is left alone.
        assertEquals("bennet_id = 3", applyDictionary("bennet_id = 3", listOf(bennett)))
    }

    @Test
    fun `multi-word aliases match across any whitespace`() {
        val kubectl = DictionaryEntry("2", "kubectl", listOf("cube control"), fuzzy = false)
        assertEquals("run kubectl get pods", applyDictionary("run cube  control get pods", listOf(kubectl)))
        assertEquals("please Go To the store", applyDictionary("please go to the store", listOf(DictionaryEntry("5", "Go To", emptyList()))))
    }

    @Test
    fun `sound keys collapse spelling variants of the same word`() {
        assertEquals(soundKey("whisper"), soundKey("Wispr"))
        assertEquals(soundKey("Bennett"), soundKey("bennet"))
        assertEquals(soundKey("Konvex"), soundKey("convex"))
        assertEquals(soundKey("flow"), soundKey("flo"))
        assertEquals(soundKey("kube"), soundKey("cube"))
        assertEquals(soundKey("night"), soundKey("nite"))
        assertTrue(soundKey("cat") != soundKey("dog"))
        // Words that dissolve entirely ("why") never match anything.
        assertEquals("", soundKey("why"))
        assertEquals("", soundKey(""))
    }

    @Test
    fun `the rule-based cleanup and the finishing pass both enforce the dictionary`() {
        val dictionary = listOf(wispr, convex)
        val result = basicCleanup("um so we moved to convex from whisper flow", dictionary)
        assertEquals("So we moved to Convex from Wispr Flow", result.text)
        assertTrue(result.stages.contains("dictionary"))
        assertEquals("We moved to Convex. ", finish("We moved to convex.", AppCategory.UNKNOWN, dictionary, trailingSpace = true).text)
    }

    @Test
    fun `edit distance`() {
        assertEquals(0, editDistance("clerk", "clerk", 2))
        assertEquals(1, editDistance("clark", "clerk", 2))
        assertEquals(3, editDistance("abc", "xyz", 2)) // capped at max + 1
        assertEquals(1, editDistance("form", "from", 2)) // a swap is one edit, as in text.ts
    }

    @Test
    fun `codec round-trips and migrates the legacy comma list`() {
        val encoded = DictionaryCodec.encode(listOf(wispr, convex))
        assertEquals(listOf(wispr, convex), DictionaryCodec.decode(encoded))
        assertEquals(emptyList<DictionaryEntry>(), DictionaryCodec.decode("not json"))
        assertEquals(emptyList<DictionaryEntry>(), DictionaryCodec.decode(null))

        val migrated = DictionaryCodec.fromLegacy(" Murmur, Wispr ,, murmur", now = 5L)
        assertEquals(listOf("Murmur", "Wispr"), migrated.map { it.word })
        assertTrue(migrated.all { it.id.isNotBlank() && it.createdAt == 5L })
    }
}
