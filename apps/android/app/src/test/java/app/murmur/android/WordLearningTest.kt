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
        val found = watch.check(edited, emptyList())!!
        assertEquals(listOf("Wispr Flow"), found.map { it.word })
        assertEquals("whisper flow", found.single().heard)
        // The same edit seen again by a later check is not news.
        assertTrue(watch.check(edited, emptyList())!!.isEmpty())
    }

    @Test
    fun `ignores typing after the dictation and a dictation it cannot find`() {
        val field = "I use whisper flow daily."
        val watch = CorrectionWatch.locate(field, "I use whisper flow daily.", field.length)!!
        assertTrue(watch.check("$field Also Kubernetes.", emptyList())!!.isEmpty())
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

    @Test
    fun `a word half-typed over a mis-heard one is never judged while the caret is in it`() {
        val field = "We moved the backend to convex today."
        val watch = CorrectionWatch.locate(field, field, field.length)!!
        val head = "We moved the backend to "
        var held = 0
        for (n in 1 until "Convex".length) {
            val typed = head + "Convex".take(n)
            val now = "$typed today."
            val result = watch.check(now, emptyList(), caret = typed.length, typing = true)
            assertTrue("while typing \"${"Convex".take(n)}\": $result", result.isNullOrEmpty())
            if (result == null) held++
        }
        // "Conv" and "Conve" resemble "convex" closely enough that only the caret guard holds them back.
        assertTrue(held >= 2)
        // The caret rests (or leaves the word): the finished word is judged.
        val done = "${head}Convex today."
        assertEquals(listOf("Convex"), watch.check(done, emptyList(), caret = (head + "Convex").length, typing = false)!!.map { it.word })
    }

    @Test
    fun `typing after the dictation is not mistaken for typing inside it`() {
        val field = "Ask Bennet about it."
        val watch = CorrectionWatch.locate(field, field, field.length)!!
        val now = "Ask Bennett about it. Also"
        // The caret is past the dictation, so the fixed name is judged even mid-typing.
        assertEquals(listOf("Bennett"), watch.check(now, emptyList(), caret = now.length, typing = true)!!.map { it.word })
    }
}
