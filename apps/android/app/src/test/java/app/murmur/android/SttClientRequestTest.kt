package app.murmur.android

import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.languageFromResponse
import app.murmur.android.stt.sttLanguageField
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The request shape of the OpenAI-compatible client, as the server sees it. Mirrors the
 * gpt-transcribe cases of apps/desktop/tests/stt-openai-compatible.test.ts.
 */
class SttClientRequestTest {
    private val server = MockWebServer()
    private val wav = ByteArray(64)

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.shutdown()

    private fun cfg(model: String, language: String) = SttConfig(
        kind = SttKind.OPENAI_COMPATIBLE,
        baseUrl = "http://${server.hostName}:${server.port}/v1",
        apiKey = "",
        model = model,
        language = language,
        timeoutMs = 5_000
    )

    private fun answer(body: String) {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(body))
    }

    /**
     * The multipart text fields of the request the server just took: a lookup from field name to
     * value, null for a field that was not sent.
     */
    private fun sentFields(): (String) -> String? {
        val body = server.takeRequest().body.readUtf8()
        return { name ->
            Regex("name=\"${Regex.escape(name)}\"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([^\\r\\n]*)\\r\\n")
                .find(body)?.groupValues?.get(1)
        }
    }

    @Test
    fun `gpt-transcribe gets the languages list and reports the detected language`() = runBlocking {
        // OpenAI's guide: for gpt-transcribe, `languages` replaces `language`; never send both.
        answer("""{"text":"hallo welt","languages":[{"code":"de"}]}""")
        val out = SttClient.transcribe(wav, null, cfg("gpt-transcribe", "de"))
        val sent = sentFields()
        assertEquals("de", sent("languages[]"))
        assertNull(sent("language"))
        assertEquals("gpt-transcribe", sent("model"))
        assertEquals("hallo welt", out.text)
        assertEquals("de", out.language)
    }

    @Test
    fun `every other model keeps the singular language field`() = runBlocking {
        answer("""{"text":"hallo welt","language":"german"}""")
        val out = SttClient.transcribe(wav, "Vocabulary: x.", cfg("whisper-large-v3-turbo", "de"))
        val sent = sentFields()
        assertEquals("de", sent("language"))
        assertNull(sent("languages[]"))
        assertEquals("Vocabulary: x.", sent("prompt"))
        assertEquals("german", out.language)
    }

    @Test
    fun `auto-detect sends neither field, and an empty detection list reports no language`() = runBlocking {
        answer("""{"text":"hello","languages":[]}""")
        val out = SttClient.transcribe(wav, null, cfg("gpt-transcribe", "auto"))
        val sent = sentFields()
        assertNull(sent("language"))
        assertNull(sent("languages[]"))
        assertEquals("hello", out.text)
        assertNull(out.language)
    }

    @Test
    fun `the field is decided on the model id, the language on whichever field the server filled`() {
        assertEquals("languages[]", sttLanguageField("gpt-transcribe"))
        assertEquals("languages[]", sttLanguageField(" GPT-Transcribe "))
        assertEquals("languages[]", sttLanguageField("gpt-transcribe-2026-08-26"))
        assertEquals("language", sttLanguageField("whisper-1"))
        assertEquals("language", sttLanguageField("gpt-4o-mini-transcribe"))
        assertEquals("language", sttLanguageField("gpt-4o-transcribe"))
        assertEquals("language", sttLanguageField("whisper-large-v3-turbo"))
        // The realtime model is not a file-transcription model; a shared prefix is not the family.
        assertEquals("language", sttLanguageField("gpt-live-transcribe"))
        assertEquals("language", sttLanguageField("gpt-transcriber"))
        assertEquals("language", sttLanguageField(""))

        assertNull(languageFromResponse(JSONObject("""{"text":"x"}""")))
        assertNull(languageFromResponse(JSONObject("""{"text":"x","languages":[]}""")))
        assertEquals("fr", languageFromResponse(JSONObject("""{"languages":[{"code":"fr"},{"code":"en"}]}""")))
        assertEquals("french", languageFromResponse(JSONObject("""{"language":"french","languages":[{"code":"en"}]}""")))
        assertNull(languageFromResponse(JSONObject("""{"language":"","languages":[{}]}""")))
    }
}
