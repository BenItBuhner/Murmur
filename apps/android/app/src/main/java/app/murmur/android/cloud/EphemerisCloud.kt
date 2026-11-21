package app.murmur.android.cloud

import android.content.Context
import android.util.Log
import app.murmur.android.context.ContextCapture
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

@Serializable
data class EphemerisWorkspaceDto(val id: String, val name: String = "", val kind: String = "")

@Serializable
data class EphemerisBootstrapDto(val userId: String, val workspaces: List<EphemerisWorkspaceDto> = emptyList())

@Serializable
data class EphemerisRefusedDto(val table: String = "", val recordId: String = "", val reason: String = "")

@Serializable
data class EphemerisPushDto(val accepted: Double = 0.0, val refused: List<EphemerisRefusedDto> = emptyList())

/**
 * The phone's side of the Ephemeris cloud: the context it captured (screen text, notifications, the app
 * in front) goes to the signed-in account's personal Ephemeris workspace, in the Ephemeris tables of
 * Murmur's Convex deployment (convex/ephemeris, table "context"). Text only. Timeline audio is not
 * uploaded here and must not be posted to Convex; the inference Worker stores those wavs in R2.
 * The Murmur account signs in; nothing of Murmur's own data is read or written here. Records leave
 * the phone only once the server took them.
 */
object EphemerisCloud {
    private const val TAG = "EphemerisCloud"
    private const val EVERY_MS = 10 * 60_000L
    /** A plan that is full stays full. Retrying the same batch every ten minutes is how a phone fills Convex. */
    private const val LIMIT_BACKOFF_MS = 6 * 60 * 60_000L
    private const val BATCH = 100
    const val TABLE = "context"

    private val mutex = Mutex()
    private val _last = MutableStateFlow<String?>(null)
    /** What the last send did, for the Context screen. */
    val last: StateFlow<String?> = _last

    /** Every few minutes while the app runs: send what is waiting. A full plan waits hours, not minutes. */
    suspend fun run(context: Context) {
        delay(30_000L)
        while (true) {
            var wait = EVERY_MS
            if (ContextCapture.enabled.value) {
                sync(context).onFailure { err ->
                    Log.i(TAG, "context not sent: ${err.message}")
                    if (err.message.orEmpty().contains("limit", ignoreCase = true)) wait = LIMIT_BACKOFF_MS
                }
            }
            delay(wait)
        }
    }

    /** A stable id per record, so a resend after a dropped answer lands on the same row. */
    fun recordId(device: String, at: String, kind: String): String = "$device|$kind|$at".take(200)

    /** Sends everything waiting. The number of records the server took. */
    suspend fun sync(context: Context): Result<Int> = mutex.withLock {
        runCatching {
            val convex = CloudSync.get()?.ephemerisClient ?: error("Sign in to your Murmur account to send context to Ephemeris.")
            val boot = try {
                convex.mutation<EphemerisBootstrapDto>("ephemeris/account:bootstrap")
            } catch (e: Exception) {
                throw IllegalStateException(
                    if (e.message.orEmpty().contains("Could not find", ignoreCase = true))
                        "Ephemeris isn't on the server yet; it arrives with the next Murmur release."
                    else "Ephemeris did not answer: ${e.message}", e
                )
            }
            val ws = boot.workspaces.firstOrNull { it.kind == "personal" } ?: boot.workspaces.firstOrNull()
                ?: error("Your account has no Ephemeris workspace yet.")
            val device = "android:" + android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID).orEmpty()
            var sent = 0
            while (true) {
                val batch = ContextCapture.peek(context, BATCH)
                if (batch.isEmpty()) break
                val changes = batch.map { (rec, line) ->
                    mapOf(
                        "table" to TABLE,
                        "recordId" to recordId(rec.device, rec.at, rec.kind),
                        "data" to line,
                        "version" to (runCatching { java.time.Instant.parse(rec.at).toEpochMilli() }.getOrDefault(System.currentTimeMillis())).toDouble()
                    )
                }
                val answer = convex.mutation<EphemerisPushDto>(
                    "ephemeris/sync:push",
                    mapOf("workspaceId" to ws.id, "deviceId" to device.take(100), "changes" to changes)
                )
                val unknown = answer.refused.count { it.reason == "unknown" }
                if (unknown == batch.size) error("The server does not take phone context yet; it arrives with the next Murmur release.")
                if (answer.refused.any { it.reason == "limit" }) error("Your Ephemeris plan's record limit is reached.")
                // Everything else landed (or the server already held a later copy): it may leave the phone.
                ContextCapture.drop(context, batch.size)
                sent += batch.size
            }
            _last.value = "Sent $sent records to Ephemeris."
            sent
        }.onFailure { _last.value = it.message }
    }
}
