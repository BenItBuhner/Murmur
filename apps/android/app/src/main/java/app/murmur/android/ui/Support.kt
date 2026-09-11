package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import com.clerk.api.Clerk
import java.util.Calendar
import kotlinx.coroutines.flow.MutableStateFlow

/** The resolved view of where speech and formatting run, shared by the settings screens. */
data class InferenceView(
    /** This build talks to a configured instance, so Murmur models are a possible choice at all. */
    val cloudEnabled: Boolean,
    /** The instance offers managed models (true until the account status says otherwise). */
    val managedAvailable: Boolean,
    val routing: InferenceRouting,
    val signedIn: Boolean,
    val status: InferenceStatusDto?,
    val plan: String,
    val sttReady: Boolean,
    val llmReady: Boolean
) {
    /** Murmur models can be offered in the UI. */
    val offersMurmur: Boolean get() = cloudEnabled && managedAvailable

    val planLabel: String get() = if (plan == "pro") "Pro" else "Free"

    /** "12 of 120 min this month", or null before the account status arrived. */
    val minutesLabel: String?
        get() {
            val s = status ?: return null
            val used = s.sttSecondsIn(InferenceStatusDto.currentPeriod()) / 60.0
            val limit = s.limits.sttSecondsPerMonth / 60.0
            val shown = if (used > 0 && used < 1) "<1" else Math.round(used).toString()
            return "$shown of ${Math.round(limit)} min this month"
        }
}

/** Build configuration, sync status and Clerk session folded into one view for the current settings. */
@Composable
fun rememberInferenceView(settings: MurmurSettings): InferenceView {
    val app = LocalContext.current.applicationContext
    val config = (app as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    val clerkUser by (if (config.enabled) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val signedIn = config.enabled && clerkUser != null
    val status = syncStatus?.inference
    val managedAvailable = status?.available ?: true
    val routing = Inference.resolveSources(settings, config.managedModels, managedAvailable)
    return InferenceView(
        cloudEnabled = config.managedModels,
        managedAvailable = managedAvailable,
        routing = routing,
        signedIn = signedIn,
        status = status,
        plan = status?.plan ?: syncStatus?.user?.plan ?: "free",
        sttReady = Inference.sttReady(settings, routing, signedIn),
        llmReady = Inference.llmReady(settings, routing, signedIn)
    )
}

val InferenceRouting.murmurStt: Boolean get() = stt == InferenceSource.MURMUR
val InferenceRouting.murmurLlm: Boolean get() = llm == InferenceSource.MURMUR

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

/** The user's own speech provider has what it needs to take a request (see [InferenceView.sttReady] for the resolved source). */
val MurmurSettings.ownProviderConfigured: Boolean
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
