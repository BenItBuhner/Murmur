package app.murmur.android.settings

import java.net.URI

/**
 * A model id its hosted provider has retired, and the replacement the provider recommends. Port of
 * apps/desktop/src/shared/models.ts; the two tables must agree.
 */
data class RetiredModel(
    /** Host of the provider's API, compared case-insensitively with the base URL's host. */
    val host: String,
    val model: String,
    val replacement: String,
    /** Shutdown date (YYYY-MM-DD) from the provider's deprecation page. */
    val retiredOn: String
)

/**
 * Model ids the hosted providers have retired. The screens stop suggesting them and
 * [SettingsStore] moves an install that still names one onto the replacement once, so nobody's
 * dictation starts failing the day a provider pulls a model.
 *
 * Only exact provider hosts are matched: the same id on a proxy or another server may still work
 * there, and a local server is nobody's business but the user's.
 */
object RetiredModels {
    const val GROQ_HOST = "api.groq.com"
    const val OPENAI_HOST = "api.openai.com"

    val ALL: List<RetiredModel> = listOf(
        // https://console.groq.com/docs/deprecations
        RetiredModel(GROQ_HOST, "llama-3.1-8b-instant", "openai/gpt-oss-20b", "2026-08-16"),
        RetiredModel(GROQ_HOST, "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "2026-08-16"),
        RetiredModel(GROQ_HOST, "distil-whisper-large-v3-en", "whisper-large-v3-turbo", "2025-08-23"),
        // https://developers.openai.com/api/docs/deprecations
        RetiredModel(OPENAI_HOST, "gpt-4.1-nano", "gpt-5.6-luna", "2026-10-23"),
        RetiredModel(OPENAI_HOST, "gpt-4.1-nano-2025-04-14", "gpt-5.6-luna", "2026-10-23"),
        // Transcription models, announced 2026-08-26. OpenAI names gpt-live-transcribe or
        // gpt-transcribe as the replacement; the former is the Realtime-session model, the latter
        // the one for /v1/audio/transcriptions, which is what both apps send recordings to.
        RetiredModel(OPENAI_HOST, "whisper-1", "gpt-transcribe", "2027-02-26"),
        RetiredModel(OPENAI_HOST, "gpt-4o-transcribe", "gpt-transcribe", "2027-02-26"),
        RetiredModel(OPENAI_HOST, "gpt-4o-mini-transcribe", "gpt-transcribe", "2027-02-26"),
        RetiredModel(OPENAI_HOST, "gpt-4o-transcribe-diarize", "gpt-transcribe", "2027-02-26"),
        // The dated snapshot has its own notice (2026-07-20) and its own replacement, the later snapshot.
        RetiredModel(OPENAI_HOST, "gpt-4o-mini-transcribe-2025-03-20", "gpt-4o-mini-transcribe-2025-12-15", "2027-01-20")
    )

    /** Host of an API base URL, lower-cased; empty when the URL does not parse. */
    fun baseUrlHost(baseUrl: String): String = try {
        URI(baseUrl.trim()).host?.lowercase() ?: ""
    } catch (_: Exception) {
        ""
    }

    /**
     * The model to use instead of [model] at [baseUrl], or null when the model is not known to be
     * retired at that host. A replacement that is itself retired is followed to the end.
     */
    fun replacement(baseUrl: String, model: String): String? {
        val host = baseUrlHost(baseUrl)
        if (host.isEmpty()) return null
        var current = model.trim()
        var replaced = false
        for (hop in ALL.indices) {
            val hit = ALL.firstOrNull { it.host == host && it.model == current } ?: break
            current = hit.replacement
            replaced = true
        }
        return if (replaced) current else null
    }

    /**
     * Move the speech model, its fallback and the formatting model off ids their provider retired.
     * The formatting model is judged against the server it actually talks to ("same as speech"
     * means the speech server). Returns [s] itself when nothing needed changing.
     */
    fun migrate(s: MurmurSettings): MurmurSettings {
        var out = s
        if (s.sttBaseUrl.isNotBlank()) {
            replacement(s.sttBaseUrl, s.sttModel)?.let { out = out.copy(sttModel = it) }
            replacement(s.sttBaseUrl, s.sttFallbackModel)?.let { out = out.copy(sttFallbackModel = it) }
        }
        val llmBaseUrl = if (s.llmSameAsStt) s.sttBaseUrl else s.llmBaseUrl
        if (llmBaseUrl.isNotBlank()) {
            replacement(llmBaseUrl, s.llmModel)?.let { out = out.copy(llmModel = it) }
        }
        return out
    }
}
