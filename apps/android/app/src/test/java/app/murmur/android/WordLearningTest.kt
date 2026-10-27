package app.murmur.android

import app.murmur.android.learn.CorrectionWatch
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.WordSuggestion
import app.murmur.android.settings.WordSuggestions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Learning dictionary words from the user's corrections in a field Murmur typed into. */
class WordLearningTest {
    @Test
    fun `finds the dictation at the caret and reports a correction once`() {
        val field = "Hi team, I use whisper flow daily. "
        val watch = CorrectionWatch.locate(field, "I use whisper flow daily. ", field.length)!!
        assertEquals(9, watch.start)
        val edited = field.replace("whisper flow", "Wispr Flow")
        val found = watch.check(edited, emptyList())
        assertEquals(listOf("Wispr Flow"), found.map { it.word })
        assertEquals("whisper flow", found.single().heard)
        // The same edit seen again by a later check is not news.
        assertTrue(watch.check(edited, emptyList()).isEmpty())
    }

    @Test
    fun `ignores typing after the dictation and a dictation it cannot find`() {
        val field = "I use whisper flow daily."
        val watch = CorrectionWatch.locate(field, "I use whisper flow daily.", field.length)!!
        assertTrue(watch.check("$field Also Kubernetes.", emptyList()).isEmpty())
        assertNull(CorrectionWatch.locate("something else", "I use whisper flow", 5))
    }

    @Test
    fun `an accepted suggestion becomes an entry or one more heard-as spelling`() {
        val add = WordSuggestion("Wispr Flow", "whisper flow", "add", 0)
        val added = WordSuggestions.withSuggestion(emptyList(), add)
        assertEquals("Wispr Flow", added.single().word)
        assertEquals(listOf("whisper flow"), added.single().aliases)

        val murmur = DictionaryEntry("1", "Murmur", listOf("murmer"))
        val alias = WordSuggestions.withSuggestion(listOf(murmur), WordSuggestion("Murmur", "mermer", "alias", 0))
        assertEquals(listOf("murmer", "mermer"), alias.single().aliases)
        // Known already: unchanged.
        assertEquals(listOf(murmur), WordSuggestions.withSuggestion(listOf(murmur), WordSuggestion("Murmur", "murmer", "alias", 0)))

        val convex = DictionaryEntry("2", "convex")
        val recased = WordSuggestions.withSuggestion(listOf(convex), WordSuggestion("Convex", "convex", "alias", 0))
        assertEquals("Convex", recased.single().word)
    }
}
