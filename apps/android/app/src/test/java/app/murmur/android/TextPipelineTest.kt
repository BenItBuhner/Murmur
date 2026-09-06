package app.murmur.android

import app.murmur.android.text.DEFAULT_FILLERS
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.applyLineCommands
import app.murmur.android.text.applyLiteralPunctuation
import app.murmur.android.text.applyScratchThat
import app.murmur.android.text.applySelfCorrections
import app.murmur.android.text.applySpokenQuotes
import app.murmur.android.text.capitalizeSentences
import app.murmur.android.text.collapseRepeats
import app.murmur.android.text.countWords
import app.murmur.android.text.extractPressEnter
import app.murmur.android.text.fixPunctuationSpacing
import app.murmur.android.text.removeFillers
import app.murmur.android.text.runPipeline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the desktop suite (apps/desktop/tests/text-pipeline.test.ts) for the ported stages. */
class TextPipelineTest {

    @Test
    fun `removes mid-sentence fillers wrapped in commas`() {
        assertEquals("I think that we should go.", removeFillers("I think, um, that we should go.", DEFAULT_FILLERS))
        assertEquals("So, can you send it?", removeFillers("So, uh, can you send it?", DEFAULT_FILLERS))
    }

    @Test
    fun `removes sentence-initial fillers and re-capitalizes`() {
        assertEquals("So we left early.", removeFillers("Um, so we left early.", DEFAULT_FILLERS))
    }

    @Test
    fun `keeps sentence-ending punctuation attached to a filler`() {
        assertEquals(
            "That is the plan. Let me know.",
            removeFillers("That is the plan, um. Let me know.", DEFAULT_FILLERS)
        )
    }

    @Test
    fun `does not touch words that merely contain a filler`() {
        assertEquals(
            "The umbrella is under the hummus.",
            removeFillers("The umbrella is under the hummus.", DEFAULT_FILLERS)
        )
        assertEquals("I'm here", removeFillers("I'm here", listOf("m")))
    }

    @Test
    fun `collapses stutters`() {
        assertEquals("I think the report is ready", collapseRepeats("I I think the the report is is ready"))
        assertEquals("No, no, no", collapseRepeats("No, no, no"))
    }

    @Test
    fun `handles new line and new paragraph`() {
        assertEquals("First point.\nSecond point", applyLineCommands("First point. Newline second point"))
    }

    @Test
    fun `detects press enter at the end only`() {
        val r1 = extractPressEnter("Sounds good, see you then. Press enter.")
        assertTrue(r1.pressEnter)
        assertEquals("Sounds good, see you then.", r1.text)
        val r2 = extractPressEnter("sure thing send it")
        assertTrue(r2.pressEnter)
        assertEquals("sure thing", r2.text)
        val r3 = extractPressEnter("Press enter to continue the wizard")
        assertFalse(r3.pressEnter)
    }

    @Test
    fun `scratch that removes the previous phrase`() {
        assertEquals(
            "Send it today.",
            applyScratchThat("Send the file tomorrow. Actually, scratch that. Send it today.")
        )
        assertEquals("At one.", applyScratchThat("We could meet at noon, scratch that, at one."))
        assertEquals("", applyScratchThat("The meeting is Monday. Delete that."))
        assertEquals("Hello world.", applyScratchThat("Hello world. This is fine. Scratch that."))
    }

    @Test
    fun `literal question and exclamation marks`() {
        assertEquals("Are you coming?", applyLiteralPunctuation("Are you coming question mark"))
        assertEquals("Do it now!", applyLiteralPunctuation("Do it now, exclamation point."))
    }

    @Test
    fun `replaces the corrected span`() {
        assertEquals(
            "Let's meet on Wednesday at 5.",
            applySelfCorrections("Let's meet on Tuesday, no, Wednesday at 5.")
        )
        assertEquals(
            "Send it to Jane and copy Sam.",
            applySelfCorrections("Send it to John, I mean, Jane and copy Sam.")
        )
        assertEquals("I'll be there at 6 pm.", applySelfCorrections("I'll be there at 5, sorry, 6 pm."))
    }

    @Test
    fun `handles multi-word replacements and sentence starts`() {
        assertEquals("Next month works.", applySelfCorrections("Next week, no wait, next month works."))
    }

    @Test
    fun `aligns on a repeated anchor word`() {
        assertEquals("Meet me Tuesday at 6.", applySelfCorrections("Meet me Tuesday at 5, no, Tuesday at 6."))
        assertEquals("The budget is 45k for Q3.", applySelfCorrections("The budget is 40k, sorry, 45k for Q3."))
    }

    @Test
    fun `ignores negations and plain uses of no`() {
        assertEquals("There is no way, honestly.", applySelfCorrections("There is no way, honestly."))
        assertEquals("Send it Tuesday, not Wednesday.", applySelfCorrections("Send it Tuesday, not Wednesday."))
        // A repeated "no" is emphasis, not a correction marker; a real correction after it still works.
        assertEquals("No, no, no, that is wrong.", applySelfCorrections("No, no, no, that is wrong."))
        assertEquals("No, no, Wednesday.", applySelfCorrections("No, no, Tuesday, no, Wednesday."))
    }

    @Test
    fun `spoken quote commands become quotation marks, the noun quote stays`() {
        assertEquals("he said \"I will be late\" and left", applySpokenQuotes("he said quote I will be late end quote and left"))
        assertEquals("She told me, \"Do not touch that\".", applySpokenQuotes("She told me, quote, do not touch that, end quote."))
        assertEquals("the subject is \"weekly update\", then the body", applySpokenQuotes("the subject is quote weekly update unquote, then the body"))
        assertEquals("\"Yes\"", applySpokenQuotes("open quote yes close quote"))
        assertEquals("the \"expert\" showed up", applySpokenQuotes("the quote unquote expert showed up"))
        assertEquals("I got a quote from the plumber", applySpokenQuotes("I got a quote from the plumber"))
        assertEquals("end quote", applySpokenQuotes("end quote"))
        assertEquals("quote unquote", applySpokenQuotes("quote unquote"))
        assertEquals("a quote. \"No way\" was the answer", applySpokenQuotes("a quote. quote no way end quote was the answer"))
        // Through the pipeline, with literal punctuation inside the quotation.
        val opts = PipelineOptions()
        assertEquals("She said \"I will be late\" and left ", runPipeline("she said quote I will be late end quote and left", opts).text)
        assertEquals("The subject line should be \"weekly update?\" ", runPipeline("the subject line should be quote weekly update question mark end quote", opts).text)
        assertEquals("Fuck, fuck, fuck. This is so broken ", runPipeline("fuck, fuck, fuck. this is so broken", opts).text)
        assertEquals("No, no, no, that is wrong ", runPipeline("no, no, no, that is wrong", opts).text)
    }

    @Test
    fun `punctuation spacing and capitalization`() {
        assertEquals("Hello, world. Next one.", fixPunctuationSpacing("Hello ,  world .Next one."))
        assertEquals("It is done. Next we go. I said so.", capitalizeSentences("it is done. next we go. i said so."))
    }

    @Test
    fun `full pipeline cleans a messy dictation`() {
        val result = runPipeline(
            "um, so I I think we should, uh, ship it on Tuesday, no, Wednesday press enter",
            PipelineOptions()
        )
        assertTrue(result.pressEnter)
        assertEquals("So I think we should ship it on Wednesday", result.text.trim())
        assertFalse(result.empty)
    }

    @Test
    fun `empty and meaningless input is flagged`() {
        assertTrue(runPipeline("...", PipelineOptions()).empty)
        assertTrue(runPipeline("", PipelineOptions()).empty)
    }

    @Test
    fun `word counting matches desktop behaviour`() {
        assertEquals(5, countWords("I think we should go"))
        assertEquals(2, countWords("it's ready"))
        assertEquals(0, countWords("..."))
    }
}
