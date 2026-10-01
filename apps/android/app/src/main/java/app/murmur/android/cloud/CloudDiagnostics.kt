package app.murmur.android.cloud

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.SystemClock
import android.util.Log
import app.murmur.android.BuildConfig
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What the cloud path has been doing on this phone, for the Account screen's "Connection details":
 * how the cloud came up and where the boot guard stands, every Clerk token fetch and its outcome,
 * the Convex WebSocket and auth state as the client reports them, the outbox and its last flush,
 * and the last [EVENTS] things that happened in between, so a failure can be read off the phone
 * after the fact. In memory only, bounded, and never leaves the phone unless the user copies it;
 * it carries no token, no dictation text and no email address, only states, counts and errors.
 */
object CloudDiagnostics {
    private const val TAG = "MurmurCloud"
    private const val EVENTS = 60
    private const val LINE = 240

    /** One Clerk token fetch: when, for whom, how long, and the result. */
    data class TokenFetch(val at: Long, val purpose: String, val skipCache: Boolean, val durationMs: Long, val ok: Boolean, val detail: String?)

    /** One attempt to get the Convex client authenticated through the Clerk provider. */
    data class AuthAttempt(val at: Long, val attempt: Int, val ok: Boolean, val error: String?)

    /** One outbox flush: when, what went, and how it ended. */
    data class Flush(val at: Long, val sent: Int, val dropped: Int, val error: String?)

    private val events = ArrayDeque<String>()

    // ---- boot ---------------------------------------------------------------------------------
    private var boot: String = "not started"
    private var bootAt: Long = 0L
    private var guard: String = "unknown"

    // ---- Clerk ----------------------------------------------------------------------------------
    private var clerk: String = "not started"
    private var lastTokenFetch: TokenFetch? = null
    private var tokenFetchesOk = 0
    private var tokenFetchesFailed = 0

    // ---- Convex -------------------------------------------------------------------------------
    private var socket: String = "no client yet"
    private var socketSince: Long = 0L
    private var socketConnects = 0
    private var auth: String = "unauthenticated"
    private var authSince: Long = 0L
    private var lastAuthAttempt: AuthAttempt? = null
    private var authAttempts = 0
    private var lastServerAuthLoss: Long = 0L
    private var lastConvexError: String? = null
    private var lastConvexErrorAt: Long = 0L

    // ---- sync ---------------------------------------------------------------------------------
    private var sync: String = "not started"
    private var pending = 0
    private var pendingHead: String? = null
    private var lastFlush: Flush? = null
    private var lastSubscriptionDataAt: Long = 0L
    private var lastSyncRequest: String? = null

    /** The cloud's start-up outcome, as [CloudBootstrap] published it. */
    @Synchronized
    fun boot(outcome: String) {
        boot = outcome
        bootAt = now()
        event("boot: $outcome")
    }

    /** Where the boot guard stands (armed, released, tripped, retry scheduled). */
    @Synchronized
    fun guard(state: String, log: Boolean = true) {
        guard = state
        if (log) event("guard: $state")
    }

    /** Clerk's own readiness: initialised or not, a user known or not; nothing about who. */
    @Synchronized
    fun clerk(state: String) {
        if (state == clerk) return
        clerk = state
        event("clerk: $state")
    }

    /** A Clerk token fetch finished (or timed out). */
    @Synchronized
    fun tokenFetch(purpose: String, skipCache: Boolean, startedAt: Long, ok: Boolean, detail: String?) {
        val fetch = TokenFetch(now(), purpose, skipCache, now() - startedAt, ok, detail?.let(::trim))
        lastTokenFetch = fetch
        if (ok) tokenFetchesOk++ else tokenFetchesFailed++
        event("token ($purpose${if (skipCache) ", fresh" else ""}): ${if (ok) "ok" else "failed: ${fetch.detail}"} in ${fetch.durationMs} ms")
    }

    /** The Convex WebSocket changed state, as the Rust client reports it. */
    @Synchronized
    fun socket(state: String) {
        if (state == socket) return
        socket = state
        socketSince = now()
        if (state == "connected") socketConnects++
        event("websocket: $state")
    }

    /** The Convex client's auth state (unauthenticated, loading, authenticated). */
    @Synchronized
    fun auth(state: String) {
        if (state == auth) return
        auth = state
        authSince = now()
        event("convex auth: $state")
    }

    /** One attempt to authenticate the Convex client through Clerk ended. */
    @Synchronized
    fun authAttempt(attempt: Int, ok: Boolean, error: String?) {
        lastAuthAttempt = AuthAttempt(now(), attempt, ok, error?.let(::trim))
        authAttempts++
        event("convex login attempt $attempt: ${if (ok) "ok" else "failed: ${lastAuthAttempt?.error}"}")
    }

    /** The server answered a call as unauthenticated although the client thought it was signed in. */
    @Synchronized
    fun serverAuthLost(where: String) {
        lastServerAuthLoss = now()
        event("server says not authenticated ($where)")
    }

    /** A Convex call or subscription failed. */
    @Synchronized
    fun convexError(where: String, message: String?) {
        lastConvexError = "$where: ${trim(message ?: "unknown error")}"
        lastConvexErrorAt = now()
        event("convex error $lastConvexError")
    }

    /** The sync engine's phase and outbox, after every publish; logged only when the phase changes. */
    @Synchronized
    fun sync(phase: String, pendingOps: Int, head: String?) {
        val changed = phase != sync
        sync = phase
        pending = pendingOps
        pendingHead = head
        if (changed) event("sync: $phase, $pendingOps pending")
    }

    /** An outbox flush ended. */
    @Synchronized
    fun flush(sent: Int, dropped: Int, error: String?) {
        lastFlush = Flush(now(), sent, dropped, error?.let(::trim))
        if (sent > 0 || dropped > 0 || error != null) {
            event("flush: $sent sent, $dropped dropped${error?.let { ", failed: ${trim(it)}" }.orEmpty()}")
        }
    }

    /** A subscription delivered data (the account's dictionary, devices, status, ...). */
    @Synchronized
    fun subscriptionData(name: String) {
        lastSubscriptionDataAt = now()
        // Too frequent for the event log; the time of the last one is in the header.
        Log.d(TAG, "subscription $name delivered")
    }

    /** The user asked for a sync, and what came of it. */
    @Synchronized
    fun syncRequest(outcome: String) {
        lastSyncRequest = "${clock(now())} $outcome"
        event("sync now: $outcome")
    }

    /** Anything else worth a line. */
    @Synchronized
    fun event(message: String) {
        val line = "${clock(now())} ${trim(message)}"
        if (events.size == EVENTS) events.removeFirst()
        events.addLast(line)
        Log.i(TAG, message)
    }

    /** One line for the Account screen's row: socket, auth, outbox, last token fetch. */
    @Synchronized
    fun summary(): String {
        val now = now()
        val token = lastTokenFetch?.let { "token ${if (it.ok) "ok" else "failed"} ${elapsed(now - it.at)} ago" } ?: "no token fetched"
        return "WebSocket $socket · $auth · $pending pending · $token"
    }

    /**
     * The whole picture as one text: the current states first (so a glance says where it stands),
     * then the recent events. [context] is read for the network state at the time of the report.
     */
    @Synchronized
    fun report(context: Context?): String = buildString {
        val now = now()
        appendLine("Murmur ${BuildConfig.VERSION_NAME} (${BuildConfig.DISTRIBUTION}) · Android ${Build.VERSION.RELEASE} · ${Build.MODEL}")
        appendLine("Reported ${clock(now)} · process up ${elapsed(SystemClock.elapsedRealtime() - processStart)}")
        appendLine()
        appendLine("Boot: $boot${if (bootAt > 0) " (${ago(bootAt, now)})" else ""}")
        appendLine("Boot guard: $guard")
        appendLine("Clerk: $clerk")
        appendLine("Last token fetch: " + (lastTokenFetch?.let { f ->
            "${if (f.ok) "ok" else "failed"} ${ago(f.at, now)}, ${f.purpose}${if (f.skipCache) ", fresh" else ""}, ${f.durationMs} ms" +
                f.detail?.let { ", $it" }.orEmpty()
        } ?: "none") + " · $tokenFetchesOk ok, $tokenFetchesFailed failed")
        appendLine("Convex WebSocket: $socket${if (socketSince > 0) " since ${clock(socketSince)}" else ""} · connected $socketConnects times")
        appendLine("Convex auth: $auth${if (authSince > 0) " since ${clock(authSince)}" else ""}")
        appendLine("Last login attempt: " + (lastAuthAttempt?.let { a ->
            "#${a.attempt} ${if (a.ok) "ok" else "failed"} ${ago(a.at, now)}" + a.error?.let { ", $it" }.orEmpty()
        } ?: "none") + " · $authAttempts attempts")
        if (lastServerAuthLoss > 0) appendLine("Server said not authenticated: ${ago(lastServerAuthLoss, now)}")
        appendLine("Last Convex error: " + (lastConvexError?.let { "$it (${ago(lastConvexErrorAt, now)})" } ?: "none"))
        appendLine("Sync: $sync · $pending pending" + pendingHead?.let { " · head: $it" }.orEmpty())
        appendLine("Last flush: " + (lastFlush?.let { f ->
            "${ago(f.at, now)}, ${f.sent} sent, ${f.dropped} dropped" + f.error?.let { ", failed: $it" }.orEmpty()
        } ?: "none"))
        appendLine("Last subscription data: " + (if (lastSubscriptionDataAt > 0) ago(lastSubscriptionDataAt, now) else "none"))
        appendLine("Last sync request: ${lastSyncRequest ?: "none"}")
        appendLine("Network: ${network(context)}")
        appendLine()
        appendLine("Recent events (newest last):")
        if (events.isEmpty()) appendLine("  none") else for (line in events) appendLine("  $line")
    }

    /** One line about the device's network, as the system sees it right now. */
    fun network(context: Context?): String {
        val cm = context?.applicationContext?.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
        return try {
            val network = cm.activeNetwork ?: return "no active network"
            val caps = cm.getNetworkCapabilities(network) ?: return "active network without capabilities"
            val kind = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
                else -> "other"
            }
            val internet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            "$kind, internet ${if (internet) "yes" else "no"}, validated ${if (validated) "yes" else "no"}${if (metered) ", metered" else ""}"
        } catch (e: Exception) {
            "unreadable: ${CloudBootstrap.describe(e)}"
        }
    }

    /** Back to nothing recorded, for tests. */
    @Synchronized
    fun reset() {
        events.clear()
        boot = "not started"; bootAt = 0L; guard = "unknown"
        clerk = "not started"; lastTokenFetch = null; tokenFetchesOk = 0; tokenFetchesFailed = 0
        socket = "no client yet"; socketSince = 0L; socketConnects = 0
        auth = "unauthenticated"; authSince = 0L; lastAuthAttempt = null; authAttempts = 0
        lastServerAuthLoss = 0L; lastConvexError = null; lastConvexErrorAt = 0L
        sync = "not started"; pending = 0; pendingHead = null; lastFlush = null; lastSubscriptionDataAt = 0L; lastSyncRequest = null
    }

    private val processStart = SystemClock.elapsedRealtime()

    private fun now(): Long = System.currentTimeMillis()

    private fun clock(at: Long): String = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(at))

    private fun ago(at: Long, now: Long): String = "${elapsed((now - at).coerceAtLeast(0))} ago at ${clock(at)}"

    private fun elapsed(ms: Long): String {
        val s = ms / 1000
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> "${s / 60}m ${s % 60}s"
            else -> "${s / 3600}h ${(s % 3600) / 60}m"
        }
    }

    private fun trim(text: String): String {
        val line = text.lineSequence().firstOrNull()?.trim().orEmpty()
        return if (line.length > LINE) line.take(LINE - 1) + "…" else line
    }
}
