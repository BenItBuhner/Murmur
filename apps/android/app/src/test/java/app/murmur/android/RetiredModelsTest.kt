package app.murmur.android

import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.RetiredModels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

private const val GROQ = "https://api.groq.com/openai/v1"
private const val OPENAI = "https://api.openai.com/v1"

/** The retired-model table and the settings rewrite built on it (port of shared/models.ts). */
class RetiredModelsTest {

    @Test
    fun `retired ids map to the provider's recommended replacement`() {
        assertEquals("openai/gpt-oss-20b", RetiredModels.replacement(GROQ, "llama-3.1-8b-instant"))
        assertEquals("openai/gpt-oss-120b", RetiredModels.replacement(GROQ, "llama-3.3-70b-versatile"))
        assertEquals("whisper-large-v3-turbo", RetiredModels.replacement(GROQ, "distil-whisper-large-v3-en"))
        assertEquals("gpt-5.6-luna", RetiredModels.replacement(OPENAI, "gpt-4.1-nano"))
        assertEquals("gpt-5.6-luna", RetiredModels.replacement(OPENAI, "gpt-4.1-nano-2025-04-14"))
        // The transcription models OpenAI shuts down on 2027-02-26 all move to gpt-transcribe.
        for (model in listOf("whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize")) {
            assertEquals(model, "gpt-transcribe", RetiredModels.replacement(OPENAI, model))
        }
        // The dated snapshot follows its own notice (2027-01-20) onto the later snapshot.
        assertEquals("gpt-4o-mini-transcribe-2025-12-15", RetiredModels.replacement(OPENAI, "gpt-4o-mini-transcribe-2025-03-20"))
        // Host matching is case-insensitive and ignores the path.
        assertEquals("openai/gpt-oss-20b", RetiredModels.replacement("HTTPS://API.GROQ.COM/openai/v1/", " llama-3.1-8b-instant "))
        assertEquals("gpt-transcribe", RetiredModels.replacement("HTTPS://API.OPENAI.COM/v1/", " whisper-1 "))
    }

    @Test
    fun `models that are current, or live on another host, are left alone`() {
        assertNull(RetiredModels.replacement(GROQ, "whisper-large-v3-turbo"))
        assertNull(RetiredModels.replacement(GROQ, "openai/gpt-oss-20b"))
        assertNull(RetiredModels.replacement(OPENAI, "gpt-4o-mini"))
        assertNull(RetiredModels.replacement(OPENAI, "gpt-transcribe"))
        // Groq's id on a proxy or a local server is not Groq's to retire.
        assertNull(RetiredModels.replacement("https://litellm.example.com/v1", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("http://127.0.0.1:11434/v1", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("not a url", "llama-3.1-8b-instant"))
        // whisper-1 is the id local servers and proxies answer to; only OpenAI is retiring it.
        assertNull(RetiredModels.replacement("http://127.0.0.1:8080/v1", "whisper-1"))
        assertNull(RetiredModels.replacement("https://litellm.example.com/v1", "gpt-4o-mini-transcribe"))
        assertNull(RetiredModels.replacement(GROQ, "whisper-1"))
        assertNull(RetiredModels.replacement("", "whisper-1"))
    }

    @Test
    fun `the table matches the desktop one row for row`() {
        // apps/desktop/src/shared/models.ts; the two must stay identical.
        val expected = listOf(
            Triple(RetiredModels.GROQ_HOST, "llama-3.1-8b-instant", "openai/gpt-oss-20b" to "2026-08-16"),
            Triple(RetiredModels.GROQ_HOST, "llama-3.3-70b-versatile", "openai/gpt-oss-120b" to "2026-08-16"),
            Triple(RetiredModels.GROQ_HOST, "distil-whisper-large-v3-en", "whisper-large-v3-turbo" to "2025-08-23"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4.1-nano", "gpt-5.6-luna" to "2026-10-23"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4.1-nano-2025-04-14", "gpt-5.6-luna" to "2026-10-23"),
            Triple(RetiredModels.OPENAI_HOST, "whisper-1", "gpt-transcribe" to "2027-02-26"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4o-transcribe", "gpt-transcribe" to "2027-02-26"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4o-mini-transcribe", "gpt-transcribe" to "2027-02-26"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4o-transcribe-diarize", "gpt-transcribe" to "2027-02-26"),
            Triple(RetiredModels.OPENAI_HOST, "gpt-4o-mini-transcribe-2025-03-20", "gpt-4o-mini-transcribe-2025-12-15" to "2027-01-20")
        )
        assertEquals(expected, RetiredModels.ALL.map { Triple(it.host, it.model, it.replacement to it.retiredOn) })
    }

    @Test
    fun `migrate rewrites the speech, fallback and formatting models against their own servers`() {
        val groqEverything = MurmurSettings(
            sttBaseUrl = GROQ,
            sttModel = "distil-whisper-large-v3-en",
            sttFallbackModel = "llama-3.1-8b-instant",
            llmSameAsStt = true,
            llmModel = "llama-3.3-70b-versatile"
        )
        val migrated = RetiredModels.migrate(groqEverything)
        assertEquals("whisper-large-v3-turbo", migrated.sttModel)
        assertEquals("openai/gpt-oss-20b", migrated.sttFallbackModel)
        assertEquals("openai/gpt-oss-120b", migrated.llmModel)

        // A separate formatting server is judged on its own host, not the speech server's.
        val separate = MurmurSettings(
            sttBaseUrl = GROQ,
            sttModel = "whisper-large-v3-turbo",
            llmSameAsStt = false,
            llmBaseUrl = OPENAI,
            llmModel = "gpt-4.1-nano"
        )
        assertEquals("gpt-5.6-luna", RetiredModels.migrate(separate).llmModel)
        val proxied = separate.copy(llmBaseUrl = "https://proxy.example.com/v1", llmModel = "llama-3.1-8b-instant")
        assertEquals("llama-3.1-8b-instant", RetiredModels.migrate(proxied).llmModel)

        // OpenAI speech: model and fallback move, the formatting model on the same server stays.
        val openaiSpeech = MurmurSettings(
            sttBaseUrl = OPENAI,
            sttModel = "gpt-4o-mini-transcribe",
            sttFallbackModel = "whisper-1",
            llmSameAsStt = true,
            llmModel = "gpt-4o-mini"
        )
        val moved = RetiredModels.migrate(openaiSpeech)
        assertEquals("gpt-transcribe", moved.sttModel)
        assertEquals("gpt-transcribe", moved.sttFallbackModel)
        assertEquals("gpt-4o-mini", moved.llmModel)
        // The same ids on a local server are the user's business.
        val local = openaiSpeech.copy(sttBaseUrl = "http://127.0.0.1:8080/v1")
        assertSame(local, RetiredModels.migrate(local))

        // Nothing to change: the same instance comes back.
        val current = MurmurSettings(sttBaseUrl = GROQ, sttModel = "whisper-large-v3-turbo", llmModel = "openai/gpt-oss-20b")
        assertSame(current, RetiredModels.migrate(current))
        val blank = MurmurSettings()
        assertSame(blank, RetiredModels.migrate(blank))
    }
}
