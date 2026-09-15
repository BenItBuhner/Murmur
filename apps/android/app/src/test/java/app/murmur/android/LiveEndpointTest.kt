package app.murmur.android

import app.murmur.android.audio.Wav
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.Tone
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.text.AppCategory
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.ModelAnswer
import app.murmur.android.text.basicCleanup
import app.murmur.android.text.prepareTranscript
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Opt-in live round-trip against a real endpoint, mirroring the desktop tests/live suite:
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... \
 *   MURMUR_STT_MODEL=... MURMUR_LLM_MODEL=... ./gradlew :app:testDebugUnitTest --tests '*LiveEndpointTest*'
 */
class LiveEndpointTest {

    private fun env(name: String): String = System.getenv(name) ?: ""

    @Test
    fun `fixture transcribes and formats through the live endpoint`() = runTest {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        val baseUrl = env("MURMUR_BASE_URL")
        val apiKey = env("MURMUR_API_KEY")
        val sttModel = env("MURMUR_STT_MODEL")
        val llmModel = env("MURMUR_LLM_MODEL")
        assumeTrue("Set MURMUR_BASE_URL and MURMUR_STT_MODEL", baseUrl.isNotEmpty() && sttModel.isNotEmpty())

        val fixture = File("src/main/assets/fixtures/jfk.wav")
        val (pcm, rate) = Wav.decodePcm16(fixture.readBytes())
        val wav = Wav.encodePcm16(Wav.resample(pcm, rate, 16_000), 16_000)

        val cfg = SttConfig(SttKind.OPENAI_COMPATIBLE, baseUrl, apiKey, sttModel, "auto", 45_000)
        val stt = SttClient.transcribe(wav, null, cfg)
        println("STT (${stt.latencyMs}ms): ${stt.text}")
        assertTrue(stt.text.lowercase().contains("country"))

        val light = basicCleanup(prepareTranscript(stt.text).text, emptyList())
        assertTrue(light.text.isNotEmpty())

        if (llmModel.isNotEmpty()) {
            val cfg = LlmConfig(baseUrl, apiKey, llmModel, 30_000)
            val result = Engine.formatTranscript(
                FormatInput(
                    transcript = stt.text,
                    mode = FormattingMode.SMART,
                    context = FormatContext(AppCategory.UNKNOWN, Tone.NEUTRAL, language = "en"),
                    dictionary = emptyList()
                )
            ) { messages, maxTokens ->
                val res = LlmClient.chatComplete(cfg, messages, maxTokens = maxTokens)
                ModelAnswer(res.text, res.finishReason)
            }
            println("LLM (${result.llmMs}ms, ${result.status}): ${result.text}")
            assertTrue("model output not used: ${result.status}", result.status.outcome == FormatOutcome.USED)
            assertTrue(result.text.lowercase().contains("country"))
        }
    }
}
