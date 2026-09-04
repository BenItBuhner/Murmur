package app.murmur.android

import app.murmur.android.audio.Wav
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.Tone
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.text.AppCategory
import app.murmur.android.text.AppContext
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.runPipeline
import app.murmur.android.text.sanitizeLlmOutput
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

        val light = runPipeline(stt.text, PipelineOptions())
        assertTrue(light.text.isNotEmpty())

        if (llmModel.isNotEmpty()) {
            val res = LlmClient.chatComplete(
                LlmConfig(baseUrl, apiKey, llmModel, 30_000),
                buildFormatMessages(
                    light.text.trim(), emptyList(), Tone.NEUTRAL,
                    AppContext("test", AppCategory.UNKNOWN)
                ),
                maxTokens = maxTokensFor(light.text)
            )
            println("LLM (${res.latencyMs}ms): ${res.text}")
            val guard = sanitizeLlmOutput(res.text, light.text)
            assertTrue("LLM output rejected: ${guard.reason}", guard.ok)
            assertTrue(guard.text.lowercase().contains("country"))
        }
    }
}
