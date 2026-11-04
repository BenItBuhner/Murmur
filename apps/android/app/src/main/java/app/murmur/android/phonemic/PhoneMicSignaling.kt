package app.murmur.android.phonemic

import app.murmur.android.cloud.ClerkCredentials
import dev.convex.android.ConvexClientWithAuth
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class MicIceServerDto(val urls: JsonElement, val username: String? = null, val credential: String? = null) {
    val urlList: List<String>
        get() = when (val u = urls) {
            is JsonPrimitive -> listOf(u.content)
            is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.content }
            else -> emptyList()
        }
}

@Serializable
data class MicReceiverDto(val deviceId: String, val name: String, val platform: String, val registeredAt: Double)

@Serializable
data class MicReceiversDto(val receivers: List<MicReceiverDto>, val iceServers: List<MicIceServerDto>)

@Serializable
data class MicSignalDto(
    val id: String,
    val kind: String,
    val from: String,
    val fromName: String,
    val linkId: String,
    val sdp: String,
    val reason: String? = null,
    val createdAt: Double
)

@Serializable
data class MicOfferResult(val id: String)

/** Signaling for one link (see the web's `Signaling`): a listing, one offer, one answer, one delete. */
interface PhoneMicSignaling {
    suspend fun receivers(): MicReceiversDto
    suspend fun offer(to: String, from: String, fromName: String, linkId: String, sdp: String)
    /** The desktop's answer (or decline) for [linkId]; null when none came within [timeoutMs]. */
    suspend fun awaitAnswer(deviceId: String, linkId: String, timeoutMs: Long): MicSignalDto?
    suspend fun take(id: String)
}

/**
 * [PhoneMicSignaling] over the account's Convex client. The inbox is subscribed only while waiting
 * for the answer: `first` drops the subscription as soon as it arrives.
 */
class ConvexPhoneMicSignaling(private val convex: ConvexClientWithAuth<ClerkCredentials>) : PhoneMicSignaling {
    override suspend fun receivers(): MicReceiversDto =
        withTimeoutOrNull(15_000) { convex.subscribe<MicReceiversDto>("micLink:receivers").first() }
            ?.getOrThrow() ?: throw IllegalStateException("Your account did not answer. Check the connection.")

    override suspend fun offer(to: String, from: String, fromName: String, linkId: String, sdp: String) {
        convex.mutation<MicOfferResult>(
            "micLink:offer",
            mapOf("to" to to, "from" to from, "fromName" to fromName, "linkId" to linkId, "sdp" to sdp)
        )
    }

    override suspend fun awaitAnswer(deviceId: String, linkId: String, timeoutMs: Long): MicSignalDto? =
        withTimeoutOrNull(timeoutMs) {
            convex.subscribe<List<MicSignalDto>>("micLink:inbox", mapOf("deviceId" to deviceId))
                .mapNotNull { result -> result.getOrNull()?.firstOrNull { it.linkId == linkId && it.kind != "offer" } }
                .first()
        }

    override suspend fun take(id: String) {
        convex.mutation<Boolean>("micLink:take", mapOf("id" to id))
    }
}
