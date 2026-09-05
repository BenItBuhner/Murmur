package app.murmur.android

import app.murmur.android.settings.DictionaryCodec
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.applyDictionary
import app.murmur.android.text.editDistance
import app.murmur.android.text.finalizeAfterLlm
import app.murmur.android.text.runPipeline
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
    }

    @Test
    fun `pipeline enforces the dictionary before punctuation and after the LLM`() {
        val opts = PipelineOptions(dictionary = listOf(wispr, convex))
        val result = runPipeline("um so we moved to convex from whisper flow", opts)
        assertEquals("So we moved to Convex from Wispr Flow ", result.text)
        assertTrue(result.stages.contains("dictionary"))
        assertEquals("We moved to Convex. ", finalizeAfterLlm("We moved to convex.", opts).text)
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
