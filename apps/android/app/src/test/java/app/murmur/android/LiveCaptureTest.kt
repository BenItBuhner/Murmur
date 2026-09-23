package app.murmur.android

import app.murmur.android.llm.ChatMessage
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.Tone
import app.murmur.android.text.AppCategory
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.ModelAnswer
import app.murmur.android.text.finish
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin engine on bytes captured from a real endpoint ([LiveFixtures]). The speech model's
 * `verbose_json`, which [app.murmur.android.stt.SttClient] asks for first, drops the "t" of a
 * negative contraction in front of a consonant ("I don' think so"); its plain `json` of the same
 * audio keeps it.
 */
class LiveCaptureTest {
    private val ctx = FormatContext(AppCategory.UNKNOWN, Tone.NEUTRAL, language = "auto")
    private fun curly(s: String) = s.replace('\'', '’')

    private val short = listOf(
        "transcribe-1.verbose.dont-think-so.json" to "I don't think so. It's not what we need.",
        "transcribe-1.verbose.didnt-call-back.json" to "We couldn't find it and they didn't call back.",
        "transcribe-1.verbose.doesnt-matter.json" to "You'll see. It doesn't matter. We'd better go.",
        "transcribe-1.verbose.hasnt-shipped.json" to "It isn't done, it wasn't ready, and it hasn't shipped."
    )

    @Test
    fun `the captured verbose_json really is cut where the plain json is not`() {
        assertEquals("I don' think so. It's not what we need.", LiveFixtures.transcript("transcribe-1.verbose.dont-think-so.json"))
        assertEquals("I don't think so. It's not what we need.", LiveFixtures.transcript("transcribe-1.json.dont-think-so.json"))
    }

    @Test
    fun `the clean skip and the rule-based modes insert every cut transcript whole`() = runTest {
        for ((file, expected) in short) {
            for ((raw, want) in listOf(LiveFixtures.transcript(file) to expected, curly(LiveFixtures.transcript(file)) to curly(expected))) {
                var called = false
                val skipped = Engine.formatTranscript(FormatInput(raw, FormattingMode.SMART, ctx, emptyList())) { _, _ ->
                    called = true
                    ModelAnswer("unused")
                }
                assertEquals(file, FormatOutcome.SKIPPED_CLEAN, skipped.status.outcome)
                assertFalse(called)
                assertEquals("$want ", finish(skipped.text, AppCategory.UNKNOWN, emptyList(), trailingSpace = true).text)
                assertEquals(want, Engine.formatTranscript(FormatInput(raw, FormattingMode.LIGHT, ctx, emptyList()), null).text)
            }
        }
    }

    @Test
    fun `the formatting model is shown the whole contraction and the captured answer parses as is`() = runTest {
        val server = MockWebServer()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(LiveFixtures.raw("complete.what-are-you-referring-to.json")))
        server.start()
        try {
            val cfg = LlmConfig(server.url("/v1").toString(), "test-key", "complete", 5_000)
            val complete: suspend (List<ChatMessage>, Int) -> ModelAnswer = { messages, maxTokens ->
                val r = LlmClient.chatComplete(cfg, messages, maxTokens = maxTokens)
                ModelAnswer(r.text, r.finishReason)
            }
            val result = Engine.formatTranscript(
                FormatInput(LiveFixtures.transcript("transcribe-1.verbose.what-are-you-referring-to.json"), FormattingMode.SMART, ctx, emptyList()),
                complete
            )
            assertEquals(FormatOutcome.USED, result.status.outcome)
            assertEquals("What are you referring to? I don't recall. I have the worst memory in the world.", result.text)

            val sent = JSONObject(server.takeRequest().body.readUtf8()).getJSONArray("messages")
            val prompt = sent.getJSONObject(sent.length() - 1).getString("content")
            assertTrue(prompt, prompt.contains("Transcript:\nWhat are you referring to? I don't recall."))
            assertFalse(prompt, prompt.contains("don' "))
        } finally {
            server.shutdown()
        }
    }
}
