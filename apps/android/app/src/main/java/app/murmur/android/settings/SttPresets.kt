package app.murmur.android.settings

/**
 * A speech provider the connection form can be filled from. Port of `STT_PRESETS` in
 * apps/desktop/src/core/stt/presets.ts: same ids, servers and recommended models, so a preset
 * chosen on either app names the same connection.
 */
data class SttPreset(
    val id: String,
    val name: String,
    val kind: SttKind,
    val baseUrl: String,
    val defaultModel: String,
    /** Known model ids shown before discovery; discovery results replace them when available. */
    val models: List<String>,
    val requiresKey: Boolean,
    val local: Boolean = false,
    val docsUrl: String? = null,
    val note: String? = null
)

object SttPresets {
    const val CUSTOM = "custom"

    val ALL: List<SttPreset> = listOf(
        SttPreset(
            id = CUSTOM,
            name = "Custom",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "",
            defaultModel = "whisper-1",
            models = listOf("whisper-1"),
            requiresKey = false,
            note = "Any server that implements POST /v1/audio/transcriptions: proxies, LiteLLM, LocalAI, vLLM, Speaches, etc."
        ),
        SttPreset(
            id = "openai",
            name = "OpenAI",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "https://api.openai.com/v1",
            // whisper-1, gpt-4o-transcribe and gpt-4o-mini-transcribe shut down on 2027-02-26;
            // gpt-transcribe is the file-transcription model OpenAI recommends instead (RetiredModels).
            defaultModel = "gpt-transcribe",
            models = listOf("gpt-transcribe"),
            requiresKey = true,
            docsUrl = "https://platform.openai.com/docs/guides/speech-to-text"
        ),
        SttPreset(
            id = "groq",
            name = "Groq",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "https://api.groq.com/openai/v1",
            defaultModel = "whisper-large-v3-turbo",
            models = listOf("whisper-large-v3-turbo", "whisper-large-v3"),
            requiresKey = true,
            docsUrl = "https://console.groq.com/docs/speech-to-text",
            note = "Fastest hosted Whisper; whisper-large-v3-turbo usually returns in well under a second."
        ),
        SttPreset(
            id = "mistral",
            name = "Mistral (Voxtral)",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "https://api.mistral.ai/v1",
            defaultModel = "voxtral-mini-latest",
            models = listOf("voxtral-mini-latest", "voxtral-small-latest"),
            requiresKey = true,
            docsUrl = "https://docs.mistral.ai/capabilities/audio/"
        ),
        SttPreset(
            id = "deepgram",
            name = "Deepgram",
            kind = SttKind.DEEPGRAM,
            baseUrl = "https://api.deepgram.com/v1",
            defaultModel = "nova-3",
            models = listOf("nova-3", "nova-2", "nova-3-medical"),
            requiresKey = true,
            docsUrl = "https://developers.deepgram.com/docs/pre-recorded-audio",
            note = "Deepgram's Nova models. Only the API key is required."
        ),
        SttPreset(
            id = "elevenlabs",
            name = "ElevenLabs Scribe",
            kind = SttKind.ELEVENLABS,
            baseUrl = "https://api.elevenlabs.io/v1",
            defaultModel = "scribe_v1",
            models = listOf("scribe_v1", "scribe_v1_experimental"),
            requiresKey = true,
            docsUrl = "https://elevenlabs.io/docs/capabilities/speech-to-text",
            note = "ElevenLabs Scribe. Only the API key is required."
        ),
        SttPreset(
            id = "whisper-cpp",
            name = "Local: whisper.cpp",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "http://127.0.0.1:8080/v1",
            defaultModel = "whisper-1",
            models = listOf("whisper-1"),
            requiresKey = false,
            local = true,
            docsUrl = "https://github.com/ggml-org/whisper.cpp/tree/master/examples/server",
            note = "Run `whisper-server -m ggml-base.en.bin --port 8080` on a machine this phone can reach. The model field is ignored by the server."
        ),
        SttPreset(
            id = "speaches",
            name = "Local: Speaches",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "http://127.0.0.1:8000/v1",
            defaultModel = "Systran/faster-whisper-large-v3",
            models = listOf(
                "Systran/faster-whisper-large-v3",
                "Systran/faster-distil-whisper-large-v3",
                "Systran/faster-whisper-small"
            ),
            requiresKey = false,
            local = true,
            docsUrl = "https://speaches.ai/",
            note = "Speaches or faster-whisper-server on a machine this phone can reach."
        ),
        SttPreset(
            id = "lm-studio",
            name = "Local: LM Studio",
            kind = SttKind.OPENAI_COMPATIBLE,
            baseUrl = "http://127.0.0.1:1234/v1",
            defaultModel = "whisper-1",
            models = listOf("whisper-1"),
            requiresKey = false,
            local = true,
            note = "LM Studio, LocalAI or vLLM on a machine this phone can reach."
        )
    )

    /** The preset with [id], or Custom for an unknown or blank id. */
    fun find(id: String?): SttPreset = ALL.firstOrNull { it.id == id } ?: ALL[0]
}
