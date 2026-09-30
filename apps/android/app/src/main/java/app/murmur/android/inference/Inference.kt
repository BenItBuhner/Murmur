package app.murmur.android.inference

import android.content.Context
import android.util.Log
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.ClerkTokens
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.llm.ChatMessage
import app.murmur.android.llm.ChatResult
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatResult
import app.murmur.android.text.ModelAnswer
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.SttSpeed
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttErrorKind
import app.murmur.android.stt.SttException
import app.murmur.android.stt.TranscribeOutput

private const val TAG = "MurmurInference"

/**
 * Where speech-to-text and smart formatting run. Port of apps/desktop/src/shared/inference.ts.
 *
 * - MURMUR: the models the Murmur instance provides for signed-in accounts, reached through the
 *   deployment's OpenAI-compatible gateway with the Clerk session as the bearer token. Only exists
 *   in builds that talk to a cloud instance; the default there.
 * - CUSTOM: a provider the user configured on this phone. The only option in local builds, where
 *   nothing is ever sent to a Murmur server.
 */
object Inference {
    /** Model ids the gateway accepts (MURMUR_MODELS in packages/backend/convex/lib/inference.ts). */
    const val STT_MODEL = "murmur-transcribe"
    const val LLM_MODEL = "murmur-format"

    /** `provider` recorded for dictations transcribed by the Murmur instance. */
    const val PROVIDER = "murmur"

    /**
     * Speed modes of the Murmur speech model (desktop `SPEED_MODES`; `SPEED_MODES` on the gateway):
     * `normal` is the instance's model as before, `fast` a quicker one when the instance offers it
     * (`MURMUR_INFERENCE_STT_FAST_MODEL`). Sent with every Murmur transcription as the `speed` form
     * part; the answer says which mode ran, so a request for Fast on an instance without it still
     * goes through, on Normal, and the app can say so.
     */
    const val SPEED_NORMAL = "normal"
    const val SPEED_FAST = "fast"
    val SPEED_MODES = listOf(SPEED_NORMAL, SPEED_FAST)
    const val SPEED_FIELD = "speed"
    /** Response header: the mode that transcribed the clip. */
    const val SPEED_HEADER = "x-murmur-speed"
    /** Response header, only when the requested mode could not be honoured: why Normal ran instead. */
    const val SPEED_FALLBACK_HEADER = "x-murmur-speed-fallback"
    val SPEED_FALLBACKS = listOf("not_configured", "model_not_found")

    /** The one sentence the apps say when Fast was asked for and Normal answered. */
    const val FAST_UNAVAILABLE_NOTE = "Fast isn't available yet, used Normal"
    /** The Speed setting's explanation, the same words as the desktop's Models page. */
    const val SPEED_SETTING_DESCRIPTION =
        "Normal: today's speech model with AI formatting. Fast: faster speech model and no AI formatting, just the instant Light cleanup. A per-app rule on the Style screen can pick a speed for one app."
    /** Under the Speed setting when the instance reports no fast model. */
    const val FAST_UNAVAILABLE_SETTING_NOTE =
        "The faster speech model isn't available on this server yet; Fast dictations use the Normal model until it is, still without AI formatting."

    /** How a mode is named in the UI. */
    fun speedLabel(mode: String): String = if (mode == SPEED_FAST) "Fast" else "Normal"

    /**
     * Does the instance offer Fast? Null before its status arrived; an instance from before speed
     * modes (no `speedModes` in its status) offers Normal only.
     */
    fun fastAvailable(status: InferenceStatusDto?): Boolean? = status?.let { SPEED_FAST in it.speedModes }

    /** Error codes whose messages are shown to the user verbatim. */
    val ERROR_CODES = setOf(
        "unauthorized", "not_configured", "model_not_found", "clip_too_long", "quota_exceeded",
        // Private testing: the instance's models are not open to this account (a zero allowance).
        "rate_limited", "private_testing", "upstream_error", "upstream_auth", "upstream_busy",
        // Raised on the phone before a request is made.
        "murmur_signed_out", "murmur_no_token"
    )

    /** Base URL of the instance's OpenAI-compatible gateway, given its HTTP actions origin. */
    fun gatewayUrl(convexSiteUrl: String): String = convexSiteUrl.trim().trimEnd('/') + "/v1"

    /**
     * Effective sources for the current settings. Local builds always resolve to CUSTOM, whatever
     * the stored value says. In cloud builds "same server as speech" follows wherever the speech
     * model points, so a Murmur speech model means a Murmur formatting model too. An instance that
     * offers no managed models (managedAvailable == false) also resolves to CUSTOM; unknown
     * (null) counts as available so a cloud build routes to Murmur before the first status arrives.
     */
    fun resolveSources(s: MurmurSettings, cloudEnabled: Boolean, managedAvailable: Boolean?): InferenceRouting {
        if (!cloudEnabled || managedAvailable == false) return InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM)
        val llm = when {
            s.llmSource == InferenceSource.MURMUR -> InferenceSource.MURMUR
            s.llmSameAsStt -> s.sttSource
            else -> InferenceSource.CUSTOM
        }
        return InferenceRouting(s.sttSource, llm)
    }

    /** A speech model is ready for the resolved source. */
    fun sttReady(s: MurmurSettings, routing: InferenceRouting, signedIn: Boolean): Boolean =
        if (routing.stt == InferenceSource.MURMUR) signedIn
        else when (s.sttKind) {
            SttKind.OPENAI_COMPATIBLE -> s.sttBaseUrl.isNotBlank() && s.sttModel.isNotBlank()
            SttKind.DEEPGRAM, SttKind.ELEVENLABS -> s.sttApiKey.isNotBlank()
        }

    /** A formatting model is ready for the resolved source. */
    fun llmReady(s: MurmurSettings, routing: InferenceRouting, signedIn: Boolean): Boolean {
        if (routing.llm == InferenceSource.MURMUR) return signedIn
        if (s.llmModel.isBlank()) return false
        return if (s.llmSameAsStt) s.sttBaseUrl.isNotBlank() else s.llmBaseUrl.isNotBlank()
    }
}

data class InferenceRouting(val stt: InferenceSource, val llm: InferenceSource)

/** The speech connection for one dictation; `cfg` is replaced when the session token is refreshed. */
class ResolvedStt(
    val source: InferenceSource,
    var cfg: SttConfig,
    /** Tried when the primary model errors (custom providers only). */
    val fallbackModel: String,
    /** `provider` for history/stats: the provider kind id, or `murmur`. */
    val provider: String
)

data class ResolvedLlm(val source: InferenceSource, val cfg: LlmConfig)

/** Where the formatting engine runs, and the function that runs it. */
class Formatter(val source: InferenceSource, val format: suspend (FormatInput) -> FormatResult)

/**
 * Decides, for every request, whether speech and formatting go to the instance's models or to the
 * user's own provider, and builds the matching client configuration. Murmur-bound configurations
 * carry the account's short-lived session token as the API key, so they are resolved per request
 * and refreshed once when the gateway rejects one. Port of apps/desktop/src/main/inference/router.ts.
 */
class InferenceRouter(
    private val config: CloudConfig,
    private val settings: () -> MurmurSettings,
    /** Convex JWT for the signed-in account (from Clerk), or null. */
    private val token: suspend (forceRefresh: Boolean) -> String?,
    /** Whether a session is signed in; explains a missing token. */
    private val signedIn: () -> Boolean,
    /** Whether the instance offers managed models, once the account status has arrived. */
    private val managedAvailable: () -> Boolean?
) {
    val cloudEnabled: Boolean get() = config.managedModels

    private val gatewayUrl: String get() = Inference.gatewayUrl(config.convexSiteUrl)

    fun routing(): InferenceRouting = Inference.resolveSources(settings(), cloudEnabled, managedAvailable())

    /** True for a configuration that points at this instance's gateway. */
    fun isMurmur(baseUrl: String): Boolean = cloudEnabled && baseUrl.trim().trimEnd('/') == gatewayUrl

    private suspend fun sessionToken(forceRefresh: Boolean): String {
        token(forceRefresh)?.let { return it }
        if (!signedIn()) {
            throw SttException(
                "Sign in to use Murmur models, or choose your own provider under Speech model",
                SttErrorKind.AUTH, code = "murmur_signed_out"
            )
        }
        throw SttException(
            "Could not get a session token for Murmur models; check your connection and try again",
            SttErrorKind.NETWORK, code = "murmur_no_token"
        )
    }

    /**
     * [speed]: the speed this dictation runs at (a per-app rule may override the setting); the
     * device's Speed setting when null.
     */
    suspend fun stt(forceRefresh: Boolean = false, speed: SttSpeed? = null): ResolvedStt {
        val s = settings()
        if (routing().stt == InferenceSource.MURMUR) {
            return ResolvedStt(
                source = InferenceSource.MURMUR,
                cfg = SttConfig(
                    kind = SttKind.OPENAI_COMPATIBLE,
                    baseUrl = gatewayUrl,
                    apiKey = sessionToken(forceRefresh),
                    model = Inference.STT_MODEL,
                    language = s.language,
                    timeoutMs = s.sttTimeoutMs,
                    // Sent even for Normal, so the instance's log shows what was asked for.
                    speed = (speed ?: s.sttSpeed).id
                ),
                fallbackModel = "",
                provider = Inference.PROVIDER
            )
        }
        return ResolvedStt(
            source = InferenceSource.CUSTOM,
            cfg = SttConfig(s.sttKind, s.sttBaseUrl, s.sttApiKey, s.sttModel, s.language, s.sttTimeoutMs),
            fallbackModel = s.sttFallbackModel,
            provider = s.sttKind.id
        )
    }

    suspend fun llm(forceRefresh: Boolean = false): ResolvedLlm {
        val s = settings()
        if (routing().llm == InferenceSource.MURMUR) {
            return ResolvedLlm(
                InferenceSource.MURMUR,
                LlmConfig(gatewayUrl, sessionToken(forceRefresh), Inference.LLM_MODEL, s.llmTimeoutMs)
            )
        }
        val (base, key, model) = s.llmConnection()
        return ResolvedLlm(InferenceSource.CUSTOM, LlmConfig(base, key, model, s.llmTimeoutMs))
    }

    /** The formatting connection, or null with the reason when Murmur models cannot be used right now. */
    suspend fun llmOrNull(): Pair<ResolvedLlm?, String?> = try {
        llm() to null
    } catch (e: SttException) {
        null to e.friendly()
    }

    /**
     * One transcription request with the two recoveries that make sense for it: a Murmur session
     * token the gateway no longer accepts is refreshed once (`resolved.cfg` is updated so the next
     * resume round uses it too), and a user's own model that errors falls back to their fallback model.
     */
    suspend fun transcribe(resolved: ResolvedStt, wav: ByteArray, prompt: String?): TranscribeOutput {
        val cfg = resolved.cfg
        return try {
            SttClient.transcribe(wav, prompt, cfg)
        } catch (e: SttException) {
            if (resolved.source == InferenceSource.MURMUR && e.kind == SttErrorKind.AUTH) {
                Log.i(TAG, "session token rejected by the gateway; refreshing and retrying")
                val fresh = cfg.copy(apiKey = sessionToken(true))
                resolved.cfg = fresh
                return SttClient.transcribe(wav, prompt, fresh)
            }
            val fallback = resolved.fallbackModel
            if (e.retryable && fallback.isNotEmpty() && fallback != cfg.model) {
                Log.w(TAG, "STT ${cfg.model} failed (${e.kind}: ${e.message}); retrying with $fallback")
                return SttClient.transcribe(wav, prompt, cfg.copy(model = fallback))
            }
            throw e
        }
    }

    /**
     * The formatting stage for the current routing (desktop: `InferenceRouter.formatter`). Against
     * a Murmur instance the whole engine runs on the gateway's `POST /v1/format`; with the user's
     * own provider the Kotlin port of the engine runs here, with the model call going to that
     * provider. Throws when Murmur models cannot be used right now (signed out, no token).
     */
    suspend fun formatter(): Formatter {
        val resolved = llm()
        val cfg = resolved.cfg
        if (resolved.source == InferenceSource.MURMUR) {
            return Formatter(InferenceSource.MURMUR) { input -> remoteFormat(cfg, input) }
        }
        if (cfg.baseUrl.isEmpty() || cfg.model.isEmpty()) {
            return Formatter(InferenceSource.CUSTOM) { input -> Engine.formatTranscript(input, null) }
        }
        return Formatter(InferenceSource.CUSTOM) { input ->
            Engine.formatTranscript(input) { messages, maxTokens ->
                val res = complete(cfg, messages, maxTokens = maxTokens)
                ModelAnswer(res.text, res.finishReason)
            }
        }
    }

    private suspend fun remoteFormat(cfg: LlmConfig, input: FormatInput): FormatResult {
        val body = input.toJson()
        return try {
            FormatResult.fromJson(LlmClient.format(cfg, body))
        } catch (e: SttException) {
            if (e.kind != SttErrorKind.AUTH) throw e
            Log.i(TAG, "session token rejected by the gateway; refreshing and retrying")
            FormatResult.fromJson(LlmClient.format(cfg.copy(apiKey = sessionToken(true)), body))
        }
    }

    /** Chat completion that survives an expired session token: a 401 from the gateway is retried once. */
    suspend fun complete(
        cfg: LlmConfig,
        messages: List<ChatMessage>,
        temperature: Double = 0.0,
        maxTokens: Int = 512
    ): ChatResult = try {
        LlmClient.chatComplete(cfg, messages, temperature, maxTokens)
    } catch (e: SttException) {
        if (e.kind != SttErrorKind.AUTH || !isMurmur(cfg.baseUrl)) throw e
        Log.i(TAG, "session token rejected by the gateway; refreshing and retrying")
        LlmClient.chatComplete(cfg.copy(apiKey = sessionToken(true)), messages, temperature, maxTokens)
    }

    companion object {
        @Volatile private var instance: InferenceRouter? = null

        /** The app's router: build configuration, the settings store, Clerk tokens and the sync status. */
        fun get(context: Context): InferenceRouter =
            instance ?: synchronized(this) {
                instance ?: create(context).also { instance = it }
            }

        /**
         * Test seam (like [app.murmur.android.dictation.DictationController.sink]): the router the
         * controller resolves connections through, e.g. one whose session token comes from a file so
         * the live suite can dictate through a real gateway without Clerk. Null restores the app's.
         */
        @androidx.annotation.VisibleForTesting
        fun install(router: InferenceRouter?) {
            synchronized(this) { instance = router }
        }

        private fun create(context: Context): InferenceRouter {
            val app = context.applicationContext
            val config = (app as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
            val store = SettingsStore.get(app)
            return InferenceRouter(
                config = config,
                settings = { store.get() },
                token = { force -> ClerkTokens.sessionToken(force) },
                signedIn = { CloudSync.get()?.status?.value?.signedIn ?: false },
                managedAvailable = { CloudSync.get()?.status?.value?.inference?.available }
            )
        }
    }
}
