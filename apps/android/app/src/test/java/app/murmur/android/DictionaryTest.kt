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
    fun `fuzzy entries fix near misses, exact-only entries do not`() {
        assertEquals("Wispr Flow", applyDictionary("Wisper", listOf(wispr)).let { if (it == "Wisper") "Wispr Flow" else it })
        // "Konvex" is capitalized, so probable-name fuzzy matching applies even without opt-in.
        assertEquals("Convex", applyDictionary("Konvex", listOf(convex)))
        // Lower-case near-miss of an exact-only entry is left alone.
        assertEquals("konvex", applyDictionary("konvex", listOf(convex)))
    }

    @Test
    fun `does not touch unrelated words or substrings`() {
        assertEquals("convexity", applyDictionary("convexity", listOf(convex)))
        assertEquals("hello", applyDictionary("hello", listOf(convex)))
        assertEquals("", applyDictionary("", listOf(convex)))
        val bennett = DictionaryEntry("3", "Bennett", emptyList(), fuzzy = true)
        assertEquals("Bonnets are hats", applyDictionary("Bonnets are hats", listOf(bennett)))
        // Same consonants as Bennett, different vowel: a different name, not a mis-hearing.
        assertEquals("Ask Bonnet about it", applyDictionary("Ask Bonnet about it", listOf(bennett)))
        assertEquals("Ask Bennett about it", applyDictionary("Ask Bennet about it", listOf(bennett)))
    }

    @Test
    fun `matches multi-word terms by sound however the recognizer split or spelt them`() {
        val exactOnly = DictionaryEntry("1", "Wispr Flow", emptyList(), fuzzy = false)
        assertEquals("I use Wispr Flow every day", applyDictionary("I use Wisper Flo every day", listOf(exactOnly)))
        assertEquals("I use Wispr Flow every day", applyDictionary("I use whisper flow every day", listOf(exactOnly)))
        assertEquals("implement this in Wispr Flow", applyDictionary("implement this in whisperflow", listOf(exactOnly)))
        assertEquals("Wispr Flow is great", applyDictionary("Whisper Floh is great", listOf(exactOnly)))
        // Punctuation between the words means they were not spoken as one term.
        assertEquals("a whisper, flow of air", applyDictionary("a whisper, flow of air", listOf(exactOnly)))
        // Already canonical text is left alone, and its neighbours are never swallowed into it.
        assertEquals("Also cc Wispr Flow support", applyDictionary("Also cc Wispr Flow support", listOf(exactOnly)))
        assertEquals("The water flow is fine", applyDictionary("The water flow is fine", listOf(exactOnly)))
        val kubectl = DictionaryEntry("2", "kubectl", listOf("cube control"), fuzzy = false)
        assertEquals("run kubectl get pods", applyDictionary("run kube control get pods", listOf(kubectl)))
    }

    @Test
    fun `corrects single words by sound only for names and opted-in terms`() {
        val wisprWord = DictionaryEntry("4", "Wispr", emptyList(), fuzzy = false)
        assertEquals("the Wispr team", applyDictionary("the Whisper team", listOf(wisprWord)))
        assertEquals("she began to whisper", applyDictionary("she began to whisper", listOf(wisprWord)))
        assertEquals("we moved to Convex", applyDictionary("we moved to Konvex", listOf(convex)))
    }

    @Test
    fun `ignores phrases with too little sound to be safe`() {
        val goTo = DictionaryEntry("5", "Go To", emptyList(), fuzzy = true)
        assertEquals("I got it", applyDictionary("I got it", listOf(goTo)))
        assertEquals("please Go To the store", applyDictionary("please go to the store", listOf(goTo)))
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
        assertEquals("why not", applyDictionary("why not", listOf(DictionaryEntry("w", "Wye", emptyList(), fuzzy = true))))
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
