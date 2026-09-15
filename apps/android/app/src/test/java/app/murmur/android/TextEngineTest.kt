package app.murmur.android

import app.murmur.android.llm.ChatMessage
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.FormatResult
import app.murmur.android.text.ModelAnswer
import app.murmur.android.text.NumberSignature
import app.murmur.android.text.Verify
import app.murmur.android.text.basicCleanup
import app.murmur.android.text.finish
import app.murmur.android.text.prepareTranscript
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Kotlin port of packages/text-engine, behaviour by behaviour (the golden test pins the exact bytes). */
class TextEngineTest {
    private val ctx = FormatContext(AppCategory.CHAT, Tone.CASUAL, app = "com.Slack", language = "auto")

    private fun answering(vararg answers: String): Pair<suspend (List<ChatMessage>, Int) -> ModelAnswer, MutableList<List<ChatMessage>>> {
        val calls = ArrayList<List<ChatMessage>>()
        val fn: suspend (List<ChatMessage>, Int) -> ModelAnswer = { messages, _ ->
            calls.add(messages)
            ModelAnswer(answers[minOf(calls.size - 1, answers.size - 1)])
        }
        return fn to calls
    }

    private fun input(transcript: String, mode: FormattingMode = FormattingMode.SMART) =
        FormatInput(transcript, mode, ctx, emptyList())

    @Test
    fun `numbers agree between spoken and written forms and differ when changed`() {
        val same = listOf(
            "the budget is one million two hundred thousand dollars" to "The budget is $1,200,000.",
            "we are on version two point oh point one" to "We are on version 2.0.1.",
            "count with me one two three four five six seven eight nine ten" to "Count with me: one, two, three, four, five, six, seven, eight, nine, ten.",
            "we need three hundred and twenty thousand more" to "We need 320,000 more.",
            "my number is five five five one two one two" to "My number is 555-1212.",
            "the code is zero zero zero seven" to "The code is 0007.",
            "five thousand five thousand" to "5,000 5,000",
            "i need eleven hundred dollars by five thirty pm" to "I need $1,100 by 5:30 pm.",
            "the revenue was three hundred grand" to "The revenue was $300k.",
            "two and a half million" to "2,500,000",
            "march third twenty twenty four" to "March 3, 2024"
        )
        for ((spoken, written) in same) {
            assertEquals("$spoken ~ $written", NumberSignature.digitSignature(spoken), NumberSignature.digitSignature(written))
        }
        val different = listOf(
            "five thousand five thousand" to "5,000",
            "one two one two" to "12",
            "the code is zero zero zero seven" to "The code is 7.",
            "one million two hundred thousand" to "one million 200,000"
        )
        for ((spoken, written) in different) {
            assertTrue("$spoken vs $written", NumberSignature.digitSignature(spoken) != NumberSignature.digitSignature(written))
        }
        assertEquals(listOf("5", "5", "5", "1", "2", "1", "2"), NumberSignature.numberList("five five five one two one two"))
        assertEquals(listOf("20", "1"), NumberSignature.numberList("two point oh point one"))
        assertEquals(emptyList<String>(), NumberSignature.numberList("1. Finish\n2. Email"))
        assertEquals(listOf("1", "2"), NumberSignature.numberList("1. Finish\n2. Email", stripMarkers = false))
        assertEquals(2, NumberSignature.countUnits("one million two hundred thousand dollars"))
    }

    @Test
    fun `verifier accepts correct rewrites and rejects changed numbers, answers and chat`() {
        assertTrue(Verify.verifyOutput("the budget is one million two hundred thousand dollars", "The budget is $1,200,000.").ok)
        assertTrue(Verify.verifyOutput("number one finish the deck number two email the vendor", "1. Finish the deck\n2. Email the vendor").ok)
        assertEquals("numbers-changed", Verify.verifyOutput("five thousand five thousand", "5,000").reason)
        assertEquals("answered", Verify.verifyOutput("what time is the meeting tomorrow", "The meeting is at 10 am.").reason)
        assertEquals("chatty", Verify.verifyOutput("can you send me the report", "Sure! Here is the report.").reason)
        assertEquals("empty", Verify.verifyOutput("hello world", "").reason)
        assertTrue(Verify.verifyOutput("um uh", "", allowEmpty = true).ok)
        assertEquals("Hello there.", Verify.cleanModelOutput("<think>hmm</think>```\nHello there.\n```\n\nLet me know!", "hello there"))
    }

    @Test
    fun `deterministic stages`() {
        val prepared = prepareTranscript("thanks a lot new line see you tomorrow press enter")
        assertTrue(prepared.pressEnter)
        assertEquals("thanks a lot\nSee you tomorrow", prepared.text)
        assertEquals(listOf("press-enter", "line-commands"), prepared.stages)

        val light = basicCleanup(
            "um so send it tomorrow. actually scratch that. send it to whisper flow today",
            listOf(DictionaryEntry("1", "Wispr Flow", listOf("whisper flow")))
        )
        assertEquals("Send it to Wispr Flow today", light.text)
        assertEquals("One million two hundred thousand dollars", basicCleanup("one million two hundred thousand dollars", emptyList()).text)

        val finished = finish("talk to Konvex about it.", AppCategory.CHAT, listOf(DictionaryEntry("2", "Convex", emptyList(), fuzzy = true)), trailingSpace = true)
        assertEquals("talk to Convex about it. ", finished.text)
        assertEquals("git commit -m \"fix\"", finish("git commit -m \"fix\".\n", AppCategory.TERMINAL, emptyList(), trailingSpace = false).text)
        assertTrue(finish("...", AppCategory.CHAT, emptyList(), trailingSpace = true).empty)
    }

    @Test
    fun `engine sends the raw transcript and uses a verified answer`() = runTest {
        val (complete, calls) = answering("The budget is $1,200,000.")
        val r = Engine.formatTranscript(input("the budget is one million two hundred thousand dollars"), complete)
        assertEquals("The budget is $1,200,000.", r.text)
        assertEquals(FormatOutcome.USED, r.status.outcome)
        assertEquals(1, r.status.attempts)
        val user = calls[0].last()
        assertEquals("user", user.role)
        assertTrue(user.content.endsWith("Transcript:\nthe budget is one million two hundred thousand dollars"))
        assertEquals("system", calls[0][0].role)
    }

    @Test
    fun `engine retries once in strict mode, then falls back to the rule-based cleanup`() = runTest {
        val (good, goodCalls) = answering("The code is 7.", "The code is 0007.")
        val r = Engine.formatTranscript(input("the code is zero zero zero seven"), good)
        assertEquals("The code is 0007.", r.text)
        assertEquals(FormatOutcome.USED, r.status.outcome)
        assertEquals(2, r.status.attempts)
        assertTrue(r.status.retriedAfter!!.startsWith("numbers-changed"))
        assertTrue(goodCalls[1].last().content.contains("Strict:"))
        assertTrue(r.stages.contains("llm-strict"))

        val (bad, _) = answering("The code is 7.", "Sure! The code is 0007.")
        val f = Engine.formatTranscript(input("um the code is zero zero zero seven"), bad)
        assertEquals(FormatOutcome.REJECTED, f.status.outcome)
        assertEquals("chatty", f.status.detail)
        assertEquals("The code is zero zero zero seven", f.text)
        assertEquals("Sure! The code is 0007.", f.modelText)
    }

    @Test
    fun `engine degrades on errors and skips when it should`() = runTest {
        val failing: suspend (List<ChatMessage>, Int) -> ModelAnswer = { _, _ -> throw IllegalStateException("boom") }
        val failed = Engine.formatTranscript(input("hello there everyone"), failing)
        assertEquals(FormatOutcome.FAILED, failed.status.outcome)
        assertEquals("boom", failed.status.detail)
        assertEquals("Hello there everyone", failed.text)

        val truncated: suspend (List<ChatMessage>, Int) -> ModelAnswer = { _, _ -> ModelAnswer("Hello there", "length") }
        val cut = Engine.formatTranscript(input("hello there everyone how are you").copy(retry = false), truncated)
        assertEquals(FormatOutcome.REJECTED, cut.status.outcome)
        assertEquals("too-long", cut.status.detail)

        var called = false
        val spy: suspend (List<ChatMessage>, Int) -> ModelAnswer = { _, _ -> called = true; ModelAnswer("nope") }
        val light = Engine.formatTranscript(input("um hello there", FormattingMode.LIGHT), spy)
        assertEquals("Hello there", light.text)
        assertEquals("light mode", light.status.detail)
        val off = Engine.formatTranscript(input("um hello there", FormattingMode.OFF), spy)
        assertEquals("um hello there", off.text)
        val tiny = Engine.formatTranscript(input("okay thanks"), spy)
        assertEquals("shorter than 3 words", tiny.status.detail)
        val none = Engine.formatTranscript(input("hello there everyone"), null)
        assertEquals("no model configured", none.status.detail)
        assertFalse(called)

        val (complete, calls) = answering("See you tomorrow.")
        val enter = Engine.formatTranscript(input("see you tomorrow press enter"), complete)
        assertTrue(enter.pressEnter)
        assertFalse(calls[0].last().content.contains("press enter"))
        assertEquals(listOf("press-enter", "llm"), enter.stages)
    }

    @Test
    fun `gateway request and response round-trip through JSON`() {
        val body = input("hello").copy(
            context = ctx.copy(
                dictionary = listOf(app.murmur.android.text.DictionaryTerm("Wispr Flow", listOf("whisper flow"))),
                keepVerbatim = listOf("my sig"),
                precedingText = "I think",
                instructions = "British spelling"
            )
        ).toJson()
        assertEquals("hello", body.getString("transcript"))
        val c = body.getJSONObject("context")
        assertEquals("chat", c.getString("category"))
        assertEquals("casual", c.getString("tone"))
        assertEquals("com.Slack", c.getString("app"))
        assertEquals("Wispr Flow", c.getJSONArray("dictionary").getJSONObject(0).getString("word"))
        assertEquals("my sig", c.getJSONArray("keepVerbatim").getString(0))
        assertEquals("I think", c.getString("precedingText"))

        val result = FormatResult.fromJson(
            JSONObject(
                """{"text":"Hello.","pressEnter":true,"status":{"outcome":"used","attempts":2,"retriedAfter":"numbers-changed (7 -> 0007)"},"llmMs":412,"stages":["llm-strict"],"modelText":"Hello.","model":"murmur-format"}"""
            )
        )
        assertEquals("Hello.", result.text)
        assertTrue(result.pressEnter)
        assertEquals(FormatOutcome.USED, result.status.outcome)
        assertEquals(2, result.status.attempts)
        assertEquals("numbers-changed (7 -> 0007)", result.status.retriedAfter)
        assertNull(result.status.detail)
        assertEquals(412L, result.llmMs)
        assertEquals(listOf("llm-strict"), result.stages)
    }
}
