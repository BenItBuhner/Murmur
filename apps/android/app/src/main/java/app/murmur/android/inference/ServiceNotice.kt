package app.murmur.android.inference

import org.json.JSONObject
import kotlin.math.ceil

/**
 * The structured part of a gateway answer (HTTP 503, `error.code = "provider_unavailable"`) that
 * says the provider behind Murmur's models is down, unreachable or out of time: not the account,
 * not the phone, nothing the user did. The gateway cuts such a request off within its own budget,
 * so the app hears this long before its own request timeout and can say so calmly. Port of
 * `ServiceNotice` in apps/desktop/src/shared/inference.ts; the code must match `GatewayErrorCode`
 * in packages/backend/convex/lib/inference.ts.
 */
data class ServiceNotice(
    /** `speech` or `formatting`: the managed model the answer is about. */
    val service: String,
    /** `timeout`, `unreachable` or `unavailable`; `unknown` from an instance that did not say. */
    val reason: String,
    /** Seconds the gateway suggests waiting before asking again; null when it did not say. */
    val retryAfterSec: Int?,
    /** The gateway's own sentence. */
    val message: String
) {
    /** The two calm lines the pill shows, the same words as the desktop pill. */
    val title: String get() = "Murmur's $service service is unavailable right now"
    val detail: String
        get() = if (service == SPEECH) "Not your connection or your mic. Your recording is kept — try again in a moment."
        else "Not your connection. Nothing was changed — try again in a moment."

    companion object {
        const val CODE = "provider_unavailable"
        const val SPEECH = "speech"
        const val FORMATTING = "formatting"

        /**
         * Read a notice out of a gateway `error` object. Null for every other code. [fallbackService]
         * names the model the request was for, for an instance that sends the code without the field.
         */
        fun fromJson(source: JSONObject?, message: String? = null, fallbackService: String = SPEECH): ServiceNotice? {
            if (source == null || source.optString("code") != CODE) return null
            val service = source.optString("service").takeIf { it == SPEECH || it == FORMATTING } ?: fallbackService
            val retryAfter = source.optDouble("retryAfterSec")
            return ServiceNotice(
                service = service,
                reason = source.optString("reason").ifEmpty { "unknown" },
                retryAfterSec = if (retryAfter.isFinite() && retryAfter > 0) ceil(retryAfter).toInt() else null,
                message = message ?: source.optString("message", "")
            )
        }
    }
}
