package app.murmur.android

import android.content.Context
import app.murmur.android.cloud.ClerkCredentials
import dev.convex.android.AuthProvider
import dev.convex.android.AuthTokenProvider
import dev.convex.android.MobileConvexClientInterface
import dev.convex.android.NoPointer
import dev.convex.android.QuerySubscriber
import dev.convex.android.SubscriptionHandle
import dev.convex.android.WebSocketState
import dev.convex.android.WebSocketStateSubscriber
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * A Convex backend for the sync engine to talk to: the FFI seam of the Convex Android SDK, the same
 * one the SDK's own `dev.convex.android.testing.FakeFfiClient` stands in at. Every mutation is
 * recorded with its decoded arguments; a test scripts the results by function name and plays the
 * server's side of each subscription with [send].
 */
class FakeConvex : MobileConvexClientInterface {
    data class Call(val name: String, val args: JsonObject)

    /** Every mutation the engine sent, in order. */
    val calls = mutableListOf<Call>()

    /** Results by function name, as the JSON the server would return; anything else answers `null`. */
    val results = mutableMapOf<String, (JsonObject) -> String>()

    private val subscribers = mutableMapOf<String, MutableList<Pair<Map<String, String>, QuerySubscriber>>>()
    private var socket: WebSocketStateSubscriber? = null
    var tokenProvider: AuthTokenProvider? = null
        private set

    /** For `ConvexClientWithAuth`'s `ffiClientFactory`: this client, and a hold on the socket state. */
    fun factory(): (String, String, WebSocketStateSubscriber?) -> MobileConvexClientInterface = { _, _, ws ->
        socket = ws
        this
    }

    /** The WebSocket came up; the engine flushes and reports itself connected. */
    fun connect() {
        socket?.onStateChange(WebSocketState.CONNECTED)
    }

    fun calls(name: String): List<Call> = calls.filter { it.name == name }

    fun subscribed(name: String): Boolean = subscribers[name]?.isNotEmpty() == true

    /** The arguments of the live subscription to [name], each as the JSON the SDK encoded it to. */
    fun subscriptionArgs(name: String): Map<String, String>? = subscribers[name]?.firstOrNull()?.first

    /** The server's answer to every live subscription of [name]. */
    fun send(name: String, json: String) {
        for ((_, subscriber) in subscribers[name].orEmpty().toList()) subscriber.onUpdate(json)
    }

    override suspend fun mutation(name: String, args: Map<String, String>): String {
        val decoded = JsonObject(args.mapValues { Json.parseToJsonElement(it.value) })
        calls += Call(name, decoded)
        return results[name]?.invoke(decoded) ?: "null"
    }

    override suspend fun action(name: String, args: Map<String, String>): String = mutation(name, args)

    override suspend fun query(name: String, args: Map<String, String>): String =
        error("the engine subscribes; it never runs a one-shot query")

    override suspend fun setAuth(token: String?) {
        tokenProvider = null
    }

    override suspend fun setAuthCallback(provider: AuthTokenProvider?) {
        tokenProvider = provider
    }

    override suspend fun subscribe(name: String, args: Map<String, String>, subscriber: QuerySubscriber): SubscriptionHandle {
        val entry = args to subscriber
        subscribers.getOrPut(name) { mutableListOf() }.add(entry)
        return object : SubscriptionHandle(NoPointer) {
            override fun cancel() {
                subscribers[name]?.remove(entry)
            }
        }
    }
}

/** Clerk, as far as the Convex client is concerned: one account, always signed in, one token. */
class FakeClerk(private val userId: String) : AuthProvider<ClerkCredentials> {
    override suspend fun login(context: Context, onIdToken: (String?) -> Unit): Result<ClerkCredentials> = loginFromCache(onIdToken)

    override suspend fun loginFromCache(onIdToken: (String?) -> Unit): Result<ClerkCredentials> =
        Result.success(ClerkCredentials(userId = userId, email = "ann@example.com", name = "Ann Example", token = "jwt"))

    override suspend fun logout(context: Context): Result<Void?> = Result.success(null)

    override fun extractIdToken(authResult: ClerkCredentials): String = authResult.token
}
