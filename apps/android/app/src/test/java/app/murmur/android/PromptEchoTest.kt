package app.murmur.android

import app.murmur.android.text.Hallucination
import app.murmur.android.text.PromptEcho
import app.murmur.android.text.STT_BASE_PROMPT
import app.murmur.android.text.buildSttPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/text-engine/tests/prompt-echo.test.ts. */
class PromptEchoTest {
    private val vocab = "Vocabulary: Murmur, Wispr Flow, Claude Code. Dictation with punctuation."

    @Test
    fun `drops the prompt read back after the speech (Oct 29 2026)`() {
        assertEquals(
            "If we do the execution right we could get some major, major, major.",
            PromptEcho.strip("If we do the execution right we could get some major, major, major. Dictation with punctuation.", vocab)
        )
    }

    @Test
    fun `drops a transcript that is only the prompt`() {
        assertEquals("", PromptEcho.strip("Dictation with punctuation.", vocab))
        assertEquals("", PromptEcho.strip(" Dictation with punctuation.", STT_BASE_PROMPT))
        assertEquals("", PromptEcho.strip("dictation with punctuation", vocab))
        assertEquals("", PromptEcho.strip("With punctuation.", vocab))
    }

    @Test
    fun `drops the vocabulary line read back, wherever it sits`() {
        assertEquals("", PromptEcho.strip("Vocabulary: Murmur, Wispr Flow. Dictation with punctuation.", vocab))
        assertEquals("Hello there. See you.", PromptEcho.strip("Hello there. Vocabulary: Murmur, Wispr Flow, Claude Code. See you.", vocab))
    }

    @Test
    fun `keeps sentences the speaker could have said`() {
        for (t in listOf(
            "Murmur, Wispr Flow.", "Wispr Flow.", "Claude Code is great.", "We need dictation with punctuation in the app.",
            "Dictation with punctuation is the goal.", "Punctuation matters.", "The vocabulary list is long.", "Dictation."
        )) assertEquals(t, PromptEcho.strip(t, vocab))
    }

    @Test
    fun `keeps everything when no prompt was sent`() {
        assertEquals("Dictation with punctuation.", PromptEcho.strip("Dictation with punctuation.", null))
        assertEquals("Dictation with punctuation.", PromptEcho.strip("Dictation with punctuation.", ""))
    }

    @Test
    fun `turns a lone mark into nothing`() {
        assertEquals("", PromptEcho.strip(".", vocab))
        assertEquals("", PromptEcho.strip(" . ", null))
        assertEquals("", PromptEcho.strip("...", null))
        assertEquals("", PromptEcho.strip("", vocab))
    }

    @Test
    fun `works with the prompt the app builds`() {
        val prompt = buildSttPrompt(listOf("Convex", "Bennett"))
        assertEquals("Ship it.", PromptEcho.strip("Ship it. Dictation with punctuation.", prompt))
        assertEquals("", PromptEcho.strip("Vocabulary: Convex, Bennett.", prompt))
        assertEquals("Convex, Bennett.", PromptEcho.strip("Convex, Bennett.", prompt))
    }

    @Test
    fun `needs two words of the prompt in order`() {
        assertFalse(PromptEcho.isEcho("Punctuation.", vocab))
        assertFalse(PromptEcho.isEcho("Punctuation with dictation.", vocab))
        assertTrue(PromptEcho.isEcho("Dictation with punctuation!", vocab))
    }

    @Test
    fun `The End is a silence phrase`() {
        assertTrue(Hallucination.isSilencePhrase("The End"))
        assertTrue(Hallucination.isSilencePhrase("The end."))
        assertFalse(Hallucination.isSilencePhrase("The end of the story."))
    }
}
