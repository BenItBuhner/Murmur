package app.murmur.android

import app.murmur.android.settings.BulletMarker
import app.murmur.android.settings.HesitationLevel
import app.murmur.android.settings.ListStyle
import app.murmur.android.settings.ListsMode
import app.murmur.android.settings.NumbersMode
import app.murmur.android.settings.RepetitionScope
import app.murmur.android.text.ListKind
import app.murmur.android.text.ListOptions
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.applySelfCorrections
import app.murmur.android.text.collapseRepeats
import app.murmur.android.text.convertNumbers
import app.murmur.android.text.detectListIntent
import app.murmur.android.text.formatLists
import app.murmur.android.text.normalizeListMarkers
import app.murmur.android.text.removeHesitations
import app.murmur.android.text.runPipeline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors apps/desktop/tests/text-stages.test.ts for the ported stages. */
class TextStagesTest {

    private fun light(input: String) = removeHesitations(input, HesitationLevel.LIGHT)
    private fun thorough(input: String) = removeHesitations(input, HesitationLevel.THOROUGH)

    @Test
    fun `light hesitations go where the transcript marks a pause`() {
        assertEquals("I think that we should go.", light("I think, you know, that we should go."))
        assertEquals("We should go.", light("You know, we should go."))
        assertEquals("Do you know if it is ready?", light("Do you know if it is ready?"))
        assertEquals("You know what I did today.", light("You know what I did today."))
        assertEquals("I like pizza.", light("I like pizza."))
        assertEquals("It was huge.", light("It was, like, huge."))
        assertEquals("She was like, no way.", light("She was like, no way."))
        assertEquals("We could go tomorrow.", light("Like, we could go tomorrow."))
        assertEquals("Like I said, tomorrow works.", light("Like I said, tomorrow works."))
        assertEquals("The report is done.", light("I mean, the report is done."))
        assertEquals("I mean it.", light("I mean it."))
        assertEquals("The meeting is at five.", light("Let me think, the meeting is at five."))
        assertEquals("That works.", light("That works, so yeah."))
        assertEquals("We need milk.", light("Okay so, we need milk."))
        assertEquals("We could ship it Friday", light("We could ship it Friday and"))
        assertEquals("It was great.", light("It was great, you know?"))
        assertEquals("So, we left.", light("So, you know, we left."))
        assertEquals("I tried it and, yeah, it works.", light("I tried it and, yeah, it works."))
    }

    @Test
    fun `thorough hesitations remove hedges and openers but keep tag questions`() {
        assertEquals("I tried it and it works.", thorough("I tried it and, yeah, it works."))
        assertEquals("Yeah, that works.", thorough("Yeah, that works."))
        assertEquals("That works, right?", thorough("That works, right?"))
        assertEquals("So far so good.", thorough("So far so good."))
        assertEquals("We left early.", thorough("So, we left early."))
        assertEquals("We left early.", thorough("Okay, so, um, we left early."))
        assertEquals("It was a mess.", thorough("It was, sort of, a mess."))
        assertEquals("It was sort of a mess.", thorough("It was sort of a mess."))
        assertEquals("It is done.", thorough("It is done, basically."))
        assertEquals("We can ship Friday.", thorough("We can ship Friday, I guess."))
        assertEquals("We can ship Friday.", thorough("We can ship Friday or whatever."))
        assertEquals("So, it works.", removeHesitations("So, at the end of the day, it works.", HesitationLevel.LIGHT, listOf("at the end of the day")))
    }

    @Test
    fun `repetitions by scope`() {
        assertEquals("I think the report is ready", collapseRepeats("I I think the the report is is ready", RepetitionScope.WORDS))
        assertEquals("No, no, no", collapseRepeats("No, no, no", RepetitionScope.WORDS))
        assertEquals("I think so", collapseRepeats("I, I think so", RepetitionScope.WORDS))
        assertEquals("the report", collapseRepeats("th- the report", RepetitionScope.WORDS))
        assertEquals("something", collapseRepeats("s- s- something", RepetitionScope.WORDS))
        assertEquals("re-read the book", collapseRepeats("re-read the book", RepetitionScope.WORDS))
        assertEquals("I know that that is true", collapseRepeats("I know that that is true", RepetitionScope.WORDS))
        assertEquals("very, very good", collapseRepeats("very, very good", RepetitionScope.WORDS))
        assertEquals("call five five five one two one two", collapseRepeats("call five five five one two one two", RepetitionScope.WORDS))
        assertEquals("I think we should go", collapseRepeats("I think, I think we should go", RepetitionScope.PHRASES))
        assertEquals("we need to go", collapseRepeats("we need to, we need to go", RepetitionScope.PHRASES))
        assertEquals("I was going", collapseRepeats("I was - I was going", RepetitionScope.PHRASES))
        assertEquals("I want to, I need to go", collapseRepeats("I want to, I need to go", RepetitionScope.PHRASES))
        assertEquals("I need to go", collapseRepeats("I want to, I need to go", RepetitionScope.THOROUGH))
        assertEquals("We could try that", collapseRepeats("We should, we could try that", RepetitionScope.THOROUGH))
        assertEquals("If you want, I can help", collapseRepeats("If you want, I can help", RepetitionScope.THOROUGH))
        assertEquals("yesterday I need to go", collapseRepeats("yesterday I want to, I need to go", RepetitionScope.THOROUGH))
    }

    @Test
    fun `numbers in smart mode`() {
        val cases = listOf(
            "meet at five pm" to "meet at 5 pm",
            "meet at five thirty pm" to "meet at 5:30 pm",
            "meet at five thirty" to "meet at 5:30",
            "five thirty works" to "five thirty works",
            "seventeen fifty" to "seventeen fifty",
            "at five o'clock" to "at 5 o'clock",
            "I have five apples" to "I have five apples",
            "I have twenty five apples" to "I have 25 apples",
            "twenty three percent" to "23%",
            "a hundred percent" to "100%",
            "ten dollars" to "\$10",
            "ten dollars and fifty cents" to "\$10.50",
            "twenty euros" to "€20",
            "two point five" to "2.5",
            "version two point three point one" to "version 2.3.1",
            "in twenty twenty six" to "in 2026",
            "two thousand twenty six" to "2026",
            "three thousand" to "3,000",
            "two thousand dollars" to "\$2,000",
            "one hundred and five" to "105",
            "we have two million users" to "we have 2 million users",
            "one point five million" to "1.5 million",
            "call five five five one two one two" to "call 5551212",
            "one of them" to "one of them",
            "step one" to "step 1",
            "the twenty first" to "the 21st",
            "June third" to "June 3rd",
            "the second option" to "the second option",
            "Twenty people came." to "Twenty people came.",
            "Twenty percent of users" to "20% of users",
            "five to ten percent" to "5 to 10%",
            "two and a half hours" to "2.5 hours",
            "wait a second" to "wait a second",
            "First, we go" to "First, we go",
            "I saw twenty-three people" to "I saw 23 people",
            "twelve fifteen am" to "12:15 am"
        )
        for ((input, expected) in cases) assertEquals(input, expected, convertNumbers(input, NumbersMode.SMART))
        assertEquals("I have 5 apples", convertNumbers("I have five apples", NumbersMode.ALL))
        assertEquals("one of them", convertNumbers("one of them", NumbersMode.ALL))
    }

    private val auto = ListOptions(ListsMode.AUTO, ListStyle.AUTO, BulletMarker.DASH, capitalize = true)
    private val spoken = auto.copy(mode = ListsMode.SPOKEN)

    @Test
    fun `lists from commands, requests and enumerations`() {
        assertEquals("- Milk\n- Eggs\n- Bread\n", formatLists("bullet point milk, bullet point eggs, bullet point bread", auto).text)
        assertEquals("We need:\n- Milk\n- Eggs\n", formatLists("we need bullet point milk bullet point eggs", auto).text)
        assertEquals(
            "1. Buy milk.\n2. Call mom.\n3. Ship it.\n",
            formatLists("number one, buy milk. number two, call mom. number three, ship it", auto).text
        )
        assertEquals(
            "1. Thanks everyone.\n2. The budget is approved.\n3. We ship on friday.\n\nLet me know what you think",
            formatLists("first, thanks everyone. second, the budget is approved. third, we ship on friday. let me know what you think", auto).text
        )
        assertEquals("- Milk\n- Eggs\n- Bread\n", formatLists("make this a bulleted list: milk, eggs and bread", auto).text)
        assertEquals("1. Milk\n2. Eggs\n3. Bread\n", formatLists("make this a numbered list: milk, eggs and bread", auto).text)
        assertEquals("- Milk\n- Eggs\n- Bread\n", formatLists("milk, eggs and bread as a bulleted list", auto).text)
        assertEquals("Here are three things:\n- Milk\n- Eggs\n- Bread\n", formatLists("here are three things: milk, eggs and bread", auto).text)
        assertEquals("Here are three things:\n- Milk\n- Eggs\n- Bread and butter\n", formatLists("here are three things: milk, eggs, bread and butter", auto).text)
        assertEquals("- Milk\n- Eggs\n", formatLists("bullet list: milk\neggs", auto).text)
        assertEquals("1. Open the app.\n2. Click settings.\n3. Enable sync.\n", formatLists("step one, open the app. step two, click settings. step three, enable sync.", spoken).text)
    }

    @Test
    fun `lists stay prose when nothing asks for them`() {
        for (s in listOf(
            "here are three things: milk, eggs, bread, butter and jam",
            "can you grab milk, eggs and bread",
            "the first time I saw it, the second time I left",
            "wait a second, the first option is fine",
            "the second option is fine, first come first served"
        )) assertEquals(s, s, formatLists(s, auto).text)
        val ordinal = "first, thanks everyone. second, the budget is approved. third, we ship on friday."
        assertEquals(ordinal, formatLists(ordinal, spoken).text)
        assertEquals(ListKind.BULLETS, detectListIntent("put this in bullet points: a, b, c").requested)
        assertEquals(ListKind.NUMBERS, detectListIntent("as a numbered list please").requested)
        assertNull(detectListIntent("hello there").requested)
        assertEquals("- A\n- B\n1. C", normalizeListMarkers("* A\n• B\n1) C", BulletMarker.DASH))
    }

    @Test
    fun `self-corrections after an unfinished phrase are hesitation`() {
        assertEquals(
            "book the flights for twenty five people at six pm",
            applySelfCorrections("book the flights for, I mean, twenty five people at five pm, no, six pm")
        )
        assertEquals("I'll be there at 6 pm.", applySelfCorrections("I'll be there at, sorry, 6 pm."))
        assertEquals("Send it to Jane.", applySelfCorrections("Send it to John, I mean, Jane."))
    }

    @Test
    fun `full pipeline builds lists, converts numbers and reports hints`() {
        val r = runPipeline(
            "um so okay here are three things for today, first finish the the deck, second email the vendor about, you know, the pricing, and third book the flights for, I mean, twenty five people at five pm, no, six pm",
            PipelineOptions()
        )
        assertEquals(
            "So okay here are three things for today:\n1. Finish the deck\n2. Email the vendor about the pricing\n3. Book the flights for 25 people at 6 pm\n",
            r.text
        )
        assertTrue(r.hints.listApplied)
        assertTrue(r.stages.containsAll(listOf("fillers", "self-corrections", "hesitations", "repeats", "lists", "numbers")))
        val q = runPipeline("what time is the meeting tomorrow", PipelineOptions())
        assertTrue(q.hints.isQuestion)
        val off = runPipeline("make this a bulleted list: milk, eggs and bread", PipelineOptions(lists = ListsMode.OFF))
        assertEquals("Make this a bulleted list: milk, eggs and bread ", off.text)
        assertEquals(ListKind.BULLETS, off.hints.list.requested)
    }
}
