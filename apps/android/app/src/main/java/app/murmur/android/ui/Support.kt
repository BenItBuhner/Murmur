package app.murmur.android.ui

import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import java.util.Calendar

fun sttConfig(s: MurmurSettings) = SttConfig(
    kind = s.sttKind,
    baseUrl = s.sttBaseUrl,
    apiKey = s.sttApiKey,
    model = s.sttModel,
    language = s.language,
    timeoutMs = s.sttTimeoutMs
)

fun friendlyMessage(e: Exception): String =
    if (e is SttException) e.friendly() else e.message ?: "Something went wrong"

/** A speech model is connected when the provider has what it needs to take a request. */
val MurmurSettings.speechModelConfigured: Boolean
    get() = when (sttKind) {
        SttKind.OPENAI_COMPATIBLE -> sttBaseUrl.isNotBlank() && sttModel.isNotBlank()
        SttKind.DEEPGRAM, SttKind.ELEVENLABS -> sttApiKey.isNotBlank()
    }

val SttKind.displayName: String
    get() = when (this) {
        SttKind.OPENAI_COMPATIBLE -> "OpenAI-compatible"
        SttKind.DEEPGRAM -> "Deepgram"
        SttKind.ELEVENLABS -> "ElevenLabs"
    }

fun greetingFor(hour: Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)): String = when {
    hour < 5 -> "Good evening"
    hour < 12 -> "Good morning"
    hour < 18 -> "Good afternoon"
    else -> "Good evening"
}

fun pluralize(count: Int, singular: String, plural: String = singular + "s"): String =
    "$count ${if (count == 1) singular else plural}"
