package app.murmur.android.inference

import android.content.Context
import android.util.Log
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.ClerkTokens
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.llm.ChatMessage
import app.murmur.android.llm.ChatResult
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
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

    /** Error codes whose messages are shown to the user verbatim. */
    val ERROR_CODES = setOf(
        "unauthorized", "not_configured", "model_not_found", "clip_too_long", "quota_exceeded",
        "rate_limited", "upstream_error", "upstream_auth", "upstream_busy",
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

    suspend fun stt(forceRefresh: Boolean = false): ResolvedStt {
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
                    timeoutMs = s.sttTimeoutMs
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
