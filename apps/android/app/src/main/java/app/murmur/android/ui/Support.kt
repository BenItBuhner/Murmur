package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.cloud.UsageMeterDto
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.inference.Limits
import app.murmur.android.inference.PlanActions
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
    /**
     * Trial, free or Pro: the plan the account is on, as distinct from the tier whose limits apply;
     * `testing` or `unlimited` while the instance is in private testing.
     */
    val planState: String,
    /** Whole days left on the Pro trial; 0 outside of one. */
    val trialDaysLeft: Int,
    val sttReady: Boolean,
    val llmReady: Boolean,
    /**
     * The instance sells Pro. False (its `MURMUR_BILLING_ENABLED` is off) hides plan labels, the
     * trial countdown, Upgrade and Manage plan and billing links everywhere in the app.
     */
    val billingEnabled: Boolean = true
) {
    /** Murmur models can be offered in the UI. */
    val offersMurmur: Boolean get() = cloudEnabled && managedAvailable

    /** The account has allowances to show: not `testing` (none at all), not `unlimited` (no cap). */
    val metered: Boolean get() = Limits.isMetered(planState)

    /** "Pro trial", "Free", "Pro"; "Private testing", "Unlimited". */
    val planLabel: String get() = Limits.planStateLabel(planState)

    /** "Pro trial", "Free plan", "Pro plan"; "Private testing", "Unlimited". */
    val planTitle: String get() = Limits.planTitle(planState)

    /**
     * The account status has not arrived yet (or there is no account): neither the plan nor
     * whether the instance sells one is known, so the screens say "Murmur's models" and that the
     * account is being checked rather than guess at a plan (the web account page does the same).
     */
    val loading: Boolean get() = status == null

    /**
     * How the Murmur source is captioned where a plan would be named: "Murmur's models" until the
     * status arrives, then the plan while the instance sells Pro, the private-testing state when
     * there is one, otherwise nothing plan-shaped.
     */
    val sourceCaption: String
        get() = when {
            loading -> "Murmur's models"
            !metered -> planTitle
            billingEnabled -> planTitle
            else -> "Included with your account"
        }

    /**
     * A plan label is a billing thing; the private-testing states are about the server, so they
     * show. Nothing is labelled before the status says which it is.
     */
    val labelled: Boolean get() = !loading && (billingEnabled || !metered)

    /**
     * What follows "Included with your account" where the Murmur source is chosen: the plan when
     * one may be named ([labelled]) and the month's minutes when metered; null when there is
     * nothing to add (before the status arrives, or with billing off on a metered plan).
     */
    val sourceMeta: String?
        get() = listOfNotNull(if (labelled) sourceCaption else null, minutesLabel).joinToString(" · ").ifEmpty { null }

    /** The rolling and monthly allowances of the tier, with what is used and when each resets. */
    val meters: List<UsageMeterDto> get() = if (metered) Limits.usageMeters(status?.meters ?: emptyList()) else emptyList()

    /** The web page that starts an upgrade, or null when the instance offers none (hide the button). */
    val upgradeUrl: String? get() = status?.upgradeUrl

    /** The web account page (plan, invoices, cancellation), or null when the instance has no site. */
    val accountUrl: String? get() = status?.accountUrl

    /** Which of Upgrade and Manage plan the account gets, with the page each opens. */
    val planActions: PlanActions get() = Limits.planActions(planState, upgradeUrl, accountUrl, billingEnabled)

    /** Pro past the soft fair-use cap: the formatting model is paused until the month resets. */
    val formattingPaused: Boolean get() = metered && status?.formattingPaused == true

    /**
     * Whether the instance offers the Fast speed for its speech model; null until the account status
     * has arrived (an instance from before speed modes offers Normal only: false).
     */
    val fastAvailable: Boolean? get() = Inference.fastAvailable(status)

    /** "12 of 120 min this month" (or "1.5 of 60 h this month"), or null before the account status arrived or without a cap. */
    val minutesLabel: String?
        get() {
            val s = status ?: return null
            if (!metered) return null
            val used = s.sttSecondsIn(InferenceStatusDto.currentPeriod())
            return "${Limits.meterValue("sttSecondsPerMonth", used, s.limits.sttSecondsPerMonth)} this month"
        }
}

/** A fixed view for previews and screenshot harnesses; null everywhere the app runs for real. */
val LocalInferenceView = compositionLocalOf<InferenceView?> { null }

/** Build configuration, sync status and Clerk session folded into one view for the current settings. */
@Composable
fun rememberInferenceView(settings: MurmurSettings): InferenceView {
    LocalInferenceView.current?.let { return it }
    val app = LocalContext.current.applicationContext
    val config = (app as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    // Clerk is read only once the cloud came up; a failed cloud may not even have its classes.
    val cloud by CloudBootstrap.state.collectAsState()
    val cloudUsable = config.enabled && cloud.usable
    val clerkUser by (if (cloudUsable) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val signedIn = cloudUsable && clerkUser != null
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
        planState = Limits.planStateOf(status, syncStatus?.user),
        trialDaysLeft = Limits.trialDaysLeft(status?.trialEndsAt ?: syncStatus?.user?.trialEndsAt),
        sttReady = Inference.sttReady(settings, routing, signedIn),
        llmReady = Inference.llmReady(settings, routing, signedIn),
        billingEnabled = Limits.sellsPro(status)
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
