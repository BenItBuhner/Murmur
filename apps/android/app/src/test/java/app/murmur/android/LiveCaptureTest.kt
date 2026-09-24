package app.murmur.android

import app.murmur.android.llm.ChatMessage
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.Clean
import app.murmur.android.text.CleanDecision
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.ModelAnswer
import app.murmur.android.text.finish
import app.murmur.android.text.prepareTranscript
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin engine on bytes captured from a real endpoint ([LiveFixtures]). The speech model's
 * `verbose_json`, which [app.murmur.android.stt.SttClient] asks for first, drops the "t" of a
 * negative contraction in front of a consonant ("I don' think so"); its plain `json` of the same
 * audio keeps it.
 *
 * That is the speech model's defect, and Murmur does not patch a model's text with rules of its
 * own. With formatting off the transcript goes in byte for byte; light mode capitalizes and spaces
 * it and leaves every word as it came; in the default mode the cut word is exactly what keeps the
 * transcript from the clean skip, so it goes to the formatting model, which reads the whole sentence.
 */
class LiveCaptureTest {
    private val ctx = FormatContext(AppCategory.UNKNOWN, Tone.NEUTRAL, language = "auto")
    private fun curly(s: String) = s.replace('\'', '’')

    /** The transcript is the tail of the user message: what the formatting model is shown, verbatim. */
    private fun shownTo(messages: List<ChatMessage>): String {
        val prompt = messages.last().content
        return prompt.substring(prompt.lastIndexOf("Transcript:\n") + "Transcript:\n".length)
    }

    /**
     * The cut transcripts: what light mode makes of each (the sentence start capitalized, the cut
     * word as it came) and what a formatting model that read the whole sentence answers.
     */
    private data class Cut(val file: String, val light: String, val whole: String)

    private val cut = listOf(
        Cut(
            "transcribe-1.verbose.dont-think-so.json",
            "I don' think so. It's not what we need.",
            "I don't think so. It's not what we need."
        ),
        Cut(
            "transcribe-1.verbose.didnt-call-back.json",
            "We couldn't find it and they didn' call back.",
            "We couldn't find it and they didn't call back."
        ),
        Cut(
            "transcribe-1.verbose.doesnt-matter.json",
            "You'll see. It doesn' matter. We'd better go.",
            "You'll see. It doesn't matter. We'd better go."
        ),
        Cut(
            "transcribe-1.verbose.hasnt-shipped.json",
            "It isn't done, it wasn't ready, and it hasn' shipped.",
            "It isn't done, it wasn't ready, and it hasn't shipped."
        )
    )

    @Test
    fun `the captured verbose_json really is cut where the plain json is not`() {
        assertEquals("I don' think so. It's not what we need.", LiveFixtures.transcript("transcribe-1.verbose.dont-think-so.json"))
        assertEquals("I don't think so. It's not what we need.", LiveFixtures.transcript("transcribe-1.json.dont-think-so.json"))
        assertEquals(
            "What are you referring to? I don' recall. I have the worst memory in the world.",
            LiveFixtures.transcript("transcribe-1.verbose.what-are-you-referring-to.json")
        )
    }

    @Test
    fun `formatting off inserts every cut transcript byte for byte`() = runTest {
        for (c in cut) {
            for (raw in listOf(LiveFixtures.transcript(c.file), curly(LiveFixtures.transcript(c.file)))) {
                val r = Engine.formatTranscript(FormatInput(raw, FormattingMode.OFF, ctx, emptyList()), null)
                assertEquals(c.file, FormatOutcome.SKIPPED, r.status.outcome)
                assertEquals(c.file, emptyList<String>(), r.stages)
                assertEquals(c.file, raw, r.text)
                assertEquals(c.file, "$raw ", finish(r.text, AppCategory.UNKNOWN, emptyList(), trailingSpace = true).text)
            }
        }
    }

    @Test
    fun `light mode capitalizes every cut transcript and leaves every word as it came`() = runTest {
        for (c in cut) {
            for ((raw, want) in listOf(LiveFixtures.transcript(c.file) to c.light, curly(LiveFixtures.transcript(c.file)) to curly(c.light))) {
                val r = Engine.formatTranscript(FormatInput(raw, FormattingMode.LIGHT, ctx, emptyList()), null)
                assertEquals(c.file, FormatOutcome.SKIPPED, r.status.outcome)
                assertEquals(c.file, want, r.text)
                // The only rule that touched it wrote a capital letter; the cut word is the model's, untouched.
                assertEquals(c.file, emptyList<String>(), r.stages.filter { it != "capitalize" })
                assertEquals(c.file, raw.lowercase(), r.text.lowercase())
            }
        }
    }

    @Test
    fun `the default mode shows every cut transcript to the formatting model as the speech model wrote it`() = runTest {
        for (c in cut) {
            for ((raw, answer) in listOf(LiveFixtures.transcript(c.file) to c.whole, curly(LiveFixtures.transcript(c.file)) to curly(c.whole))) {
                // The cut word is exactly what keeps the transcript from the clean skip...
                assertEquals(c.file, CleanDecision(false, "truncated"), Clean.alreadyClean(prepareTranscript(raw), ctx))
                // ...so the model is called, reads the transcript untouched, and its answer is used.
                val shown = ArrayList<String>()
                val r = Engine.formatTranscript(FormatInput(raw, FormattingMode.SMART, ctx, emptyList())) { messages, _ ->
                    shown.add(shownTo(messages))
                    ModelAnswer(answer, "stop")
                }
                assertEquals(c.file, listOf(raw), shown)
                assertEquals(c.file, FormatOutcome.USED, r.status.outcome)
                assertEquals(c.file, 1, r.status.attempts)
                assertEquals(c.file, answer, r.text)
            }
        }
    }

    @Test
    fun `the formatting model reads the cut transcript whole and its captured answer parses and is used as is`() = runTest {
        // The real model saw "I don' recall" and understood it: nothing was fixed for it on the way in.
        val answer = LiveFixtures.json("complete.what-are-you-referring-to.json")
        assertTrue(answer.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("reasoning").contains("I don' recall"))

        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(LiveFixtures.raw("complete.what-are-you-referring-to.json")))
        server.start()
        try {
            val cfg = LlmConfig(server.url("/v1").toString(), "test-key", "complete", 5_000)
            val complete: suspend (List<ChatMessage>, Int) -> ModelAnswer = { messages, maxTokens ->
                val r = LlmClient.chatComplete(cfg, messages, maxTokens = maxTokens)
                ModelAnswer(r.text, r.finishReason)
            }
            val raw = LiveFixtures.transcript("transcribe-1.verbose.what-are-you-referring-to.json")
            val result = Engine.formatTranscript(FormatInput(raw, FormattingMode.SMART, ctx, emptyList()), complete)
            assertEquals(FormatOutcome.USED, result.status.outcome)
            assertEquals(1, result.status.attempts)
            assertEquals("What are you referring to? I don't recall. I have the worst memory in the world.", result.text)

            val sent = JSONObject(server.takeRequest().body.readUtf8()).getJSONArray("messages")
            val prompt = sent.getJSONObject(sent.length() - 1).getString("content")
            assertEquals(raw, prompt.substring(prompt.lastIndexOf("Transcript:\n") + "Transcript:\n".length))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `the plain json transcripts pass through untouched, and the short one needs no model`() = runTest {
        for (file in listOf("transcribe-1.json.dont-think-so.json", "transcribe-1.json.what-are-you-referring-to.json")) {
            val raw = LiveFixtures.transcript(file)
            assertEquals(file, raw, Engine.formatTranscript(FormatInput(raw, FormattingMode.OFF, ctx, emptyList()), null).text)
        }
        // Whole contractions are plain English prose: the same sentence with its "t" skips the model.
        var called = false
        val whole = LiveFixtures.transcript("transcribe-1.json.dont-think-so.json")
        val r = Engine.formatTranscript(FormatInput(whole, FormattingMode.SMART, ctx, emptyList())) { _, _ ->
            called = true
            ModelAnswer("unused")
        }
        assertEquals(FormatOutcome.SKIPPED_CLEAN, r.status.outcome)
        assertEquals(false, called)
        assertEquals(whole, r.text)
    }
}
