package app.murmur.android.cloud

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryEvent
import app.murmur.android.history.HistoryOrigin
import app.murmur.android.history.HistoryStore
import app.murmur.android.settings.AppRule
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.Snippet
import app.murmur.android.settings.SettingsOrigin
import app.murmur.android.settings.SettingsStore
import com.clerk.api.Clerk
import dev.convex.android.AuthState
import dev.convex.android.ConvexClientWithAuth
import dev.convex.android.InternalError
import dev.convex.android.WebSocketState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "MurmurCloud"
private const val RETRY_MS = 15_000L
private const val ONBOARDING_VERSION = 1.0

/** A failed attempt to authenticate with Convex is tried again after this long, doubling each time up to [AUTH_RETRY_MAX_MS]. */
private const val AUTH_RETRY_FIRST_MS = 2_000L
private const val AUTH_RETRY_MAX_MS = 60_000L

/** How many dictations follow the account: the newest this many are pushed when sync is turned on and mirrored from `history:recent`. */
private const val HISTORY_BACKLOG = 200

/** A burst of dictations is sent as one request once it has settled for this long. */
private const val HISTORY_PUSH_DELAY_MS = 250L

enum class SyncPhase { DISABLED, SIGNED_OUT, CONNECTING, SYNCING, SYNCED, OFFLINE, ERROR }

data class SyncStatus(
    val phase: SyncPhase,
    val signedIn: Boolean,
    val authenticated: Boolean,
    val connected: Boolean,
    val pendingOps: Int,
    val user: UserDto?,
    val devices: List<DeviceDto>,
    val error: String?,
    /** The account's totals across every device, once loaded; null means show the phone's own. */
    val stats: DictationStats? = null,
    /** Managed-model availability and allowance; null until the account is connected. */
    val inference: InferenceStatusDto? = null
) {
    companion object {
        val DISABLED = SyncStatus(SyncPhase.DISABLED, false, false, false, 0, null, emptyList(), null)
    }
}

/**
 * Android counterpart of the desktop sync engine (apps/desktop/src/main/cloud/sync-engine.ts).
 * Clerk reports who is signed in; Convex subscriptions deliver the account's dictionary, snippets,
 * rules, style preferences and (opt-in) dictation history; local edits are diffed into an
 * idempotent outbox and replayed. The dictionary the dictation pipeline reads is always
 * derive(server snapshot, pending ops), so the app works offline.
 *
 * Nothing here is tried only once. Authenticating the Convex client with Clerk is a loop that
 * keeps trying with backoff until it succeeds or the user signs out, and tries again at once when
 * the network comes back, the app comes to the front, the WebSocket reconnects or the user taps
 * Sync now ([nudge]); the server answering "Not authenticated" (a token refresh that failed on a
 * reconnect) starts it over. Connecting the account (`users:ensure`, the heartbeat, the first
 * merge, the subscriptions) retries the same way, and the outbox flush keeps one retry timer. The
 * Rust client reconnects the WebSocket by itself and asks the provider for a fresh token each time.
 *
 * The constructor takes every outside dependency so a test can run the whole engine against a
 * fake Convex client (see HistorySyncTest); [init] wires the real ones.
 */
class CloudSync internal constructor(
    private val app: Context,
    val config: CloudConfig,
    private val settings: SettingsStore,
    private val history: HistoryStore,
    /** Clerk user id of whoever is signed in, null for nobody; nothing until Clerk is ready. */
    private val account: Flow<String?>,
    private val scope: CoroutineScope,
    private val client: ConvexClientWithAuth<ClerkCredentials>?
) {
    private val outbox = Outbox(app)
    private val flushMutex = Mutex()

    private val _status = MutableStateFlow(SyncStatus.DISABLED)
    val status: StateFlow<SyncStatus> = _status

    private var signedIn = false
    private var authenticated = false
    private var connected = false
    /** The WebSocket has been up at least once this sign-in: afterwards, not connected means offline rather than connecting. */
    private var everConnected = false
    /** The device has a network, as far as the system has told us; true until it says otherwise. */
    @Volatile private var online = true
    private var error: String? = null
    /** Why the last attempt to authenticate with Convex failed; null once one succeeds. */
    private var authError: String? = null
    /** The server answered a call as unauthenticated while the client believed it was signed in. */
    @Volatile private var authStale = false
    /** Fresh logins in a row that the server threw away again before any subscription delivered. */
    private var staleStreak = 0
    /** The loop that gets and keeps the Convex client authenticated; replaced on every sign-in. */
    private var authJob: Job? = null
    /** The account connection in progress (`users:ensure`, heartbeat, merge, subscriptions); replaced on every authentication. */
    private var connectJob: Job? = null
    /** The one pending retry of a failed flush. */
    private var flushRetry: Job? = null
    /** "Try now" signals for the auth loop: the newest reason wins, nothing queues up. */
    private val nudges = Channel<String>(Channel.CONFLATED)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var user: UserDto? = null
    private var devices: List<DeviceDto> = emptyList()
    private var inference: InferenceStatusDto? = null
    /** The instance rejected the `day` argument: an older backend, asked the old way from then on. */
    @Volatile private var statusWithoutDay = false
    private var serverDictionary: List<DictionaryEntryDto>? = null
    private var serverSnippets: List<SnippetDto>? = null
    private var serverAppRules: List<AppRuleDto>? = null
    private var serverPreferences: PreferencesDto? = null
    private var serverStats: StatsDto? = null
    private var preferencesLoaded = false
    private var mirrorPrefs: StylePreferences = StylePreferences.of(settings.get())
    private var subscriptions: Job? = null
    /** The `history:recent` subscription, running only while history sync is on. */
    private var historySubscription: Job? = null
    private var generation = 0
    @Volatile private var applying = false

    private val settingsListener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit =
        { previous, next, origin -> onSettingsChange(previous, next, origin) }
    private val historyListener: (HistoryEvent) -> Unit = { event -> onHistoryEvent(event) }

    fun start() {
        val convex = client ?: return
        settings.addListener(settingsListener)
        history.addListener(historyListener)
        scope.launch {
            convex.webSocketStateFlow.collect { state ->
                val was = connected
                connected = state == WebSocketState.CONNECTED
                if (connected) everConnected = true
                CloudDiagnostics.socket(if (connected) "connected" else if (everConnected) "reconnecting" else "connecting")
                if (connected && !was) {
                    error = null
                    // Back on the wire: whatever waited goes now, and an unauthenticated client tries again at once.
                    nudge("websocket connected")
                    launch { flush() }
                }
                publish()
            }
        }
        scope.launch {
            convex.authState.collect { state ->
                authenticated = state is AuthState.Authenticated
                CloudDiagnostics.auth(
                    when (state) {
                        is AuthState.Authenticated -> "authenticated"
                        is AuthState.AuthLoading -> "logging in"
                        else -> "unauthenticated"
                    }
                )
                if (state is AuthState.Authenticated) {
                    authStale = false
                    authError = null
                    onAuthenticated(state.userInfo)
                }
                publish()
            }
        }
        scope.launch {
            account.distinctUntilChanged().collect { userId ->
                CloudDiagnostics.clerk(if (userId != null) "ready, a user is signed in" else "ready, nobody signed in")
                if (userId != null) onSignedIn(userId) else onSignedOut()
            }
        }
        watchNetwork()
        publish()
        Log.i(TAG, "sync engine started (${config.accountMode}, ${config.convexUrl})")
    }

    /**
     * The device's default network coming and going. Losing it is shown as offline; getting one
     * back wakes the auth loop at once instead of at the end of its backoff.
     */
    private fun watchNetwork() {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val was = online
                online = true
                if (!was) publish()
                nudge("network available")
            }

            override fun onLost(network: Network) {
                online = false
                publish()
            }

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) && !online) {
                    online = true
                    publish()
                    nudge("network validated")
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            Log.w(TAG, "cannot watch the network; relying on timed retries", e)
        }
    }

    /**
     * Something changed that makes a retry worth it now: the auth loop wakes if it is waiting out
     * a backoff, and the outbox is flushed if the client is authenticated.
     */
    private fun nudge(reason: String) {
        nudges.trySend(reason)
    }

    /** The app came to the front: whatever is waiting on a timer gets to go now. */
    fun onAppVisible() {
        if (!config.enabled || !signedIn) return
        nudge("app visible")
        if (authenticated) scope.launch { flush() }
    }

    // ---- auth ---------------------------------------------------------------------------------

    private fun onSignedIn(userId: String) {
        if (client == null) return
        val wasSignedIn = signedIn
        signedIn = true
        val previousUser = settings.get().lastSignedInUserId
        if (wasSignedIn && previousUser == userId) return
        generation++
        outbox.bind(userId)
        settings.update(SettingsOrigin.CLOUD) { it.copy(lastSignedInUserId = userId) }
        publish()
        startAuth(generation)
    }

    private fun startAuth(gen: Int) {
        authJob?.cancel()
        authJob = scope.launch { keepAuthenticated(gen) }
    }

    /**
     * Gets the Convex client authenticated through Clerk and keeps it so, for as long as this
     * sign-in ([gen]) lasts. A failed attempt (Clerk unreachable, a token that could not be minted,
     * the provider refusing) is tried again after a backoff that doubles up to a minute; a [nudge]
     * ends the wait early. Once authenticated the loop sleeps until the server reports the identity
     * gone ([authStale]) and then starts over, which hands the Rust client a fresh token.
     */
    private suspend fun keepAuthenticated(gen: Int) {
        val convex = client ?: return
        var attempt = 0
        // The loop's own record of its last attempt: `authenticated` mirrors the client's state
        // flow, which arrives on its own schedule, and must not decide whether to try again.
        var loggedIn = false
        while (gen == generation && signedIn) {
            if (loggedIn && !authStale) {
                nudges.receive()
                continue
            }
            attempt++
            val wasStale = authStale
            authStale = false
            val result = try {
                convex.loginFromCache()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // The client itself threw (the Rust side refusing the callback, a linkage error): a failure like any other.
                Result.failure(e)
            }
            if (gen != generation || !signedIn) return
            loggedIn = result.isSuccess
            result.onSuccess {
                CloudDiagnostics.authAttempt(attempt, ok = true, error = null)
                attempt = 0
                authError = null
                publish()
                if (wasStale) {
                    // The server threw the identity away again right after a fresh login: logging
                    // in a third time at once would only repeat that, so each repeat waits longer.
                    staleStreak++
                    if (staleStreak > 1) delay(authRetryDelay(staleStreak - 1))
                }
            }.onFailure { e ->
                val message = e.message ?: CloudBootstrap.describe(e)
                authError = message
                if (wasStale) authStale = true
                CloudDiagnostics.authAttempt(attempt, ok = false, error = message)
                Log.w(TAG, "could not authenticate with Convex (attempt $attempt): $message")
                publish()
                val wait = authRetryDelay(attempt)
                // Wait out the backoff, or until something says it is worth trying now.
                withTimeoutOrNull(wait) { nudges.receive() }
            }
        }
    }

    /**
     * Signed out: the account's data leaves the phone, as it leaves the desktop (`disconnectAccount`
     * with `wipe`): dictionary, snippets, rules, the history mirror and the opt-in itself. History
     * is cleared as the desktop clears it, with the cloud origin so nothing is queued for an account
     * nobody is signed in to.
     */
    private fun onSignedOut() {
        if (!signedIn) {
            publish()
            return
        }
        Log.i(TAG, "signed out; clearing account data from this device")
        signedIn = false
        generation++
        authJob?.cancel()
        authJob = null
        connectJob?.cancel()
        connectJob = null
        flushRetry?.cancel()
        flushRetry = null
        subscriptions?.cancel()
        subscriptions = null
        stopHistorySubscription()
        authenticated = false
        authStale = false
        authError = null
        everConnected = false
        user = null
        devices = emptyList()
        inference = null
        serverDictionary = null
        serverSnippets = null
        serverAppRules = null
        serverPreferences = null
        serverStats = null
        preferencesLoaded = false
        error = null
        outbox.clear()
        settings.update(SettingsOrigin.CLOUD) {
            it.copy(
                dictionaryEntries = emptyList(),
                snippets = emptyList(),
                appRules = emptyList(),
                lastSignedInUserId = "",
                historySync = false
            )
        }
        history.clear(HistoryOrigin.CLOUD)
        mirrorPrefs = StylePreferences.of(settings.get())
        scope.launch { client?.logout(app) }
        publish()
    }

    /** Authenticated (again): the account connection starts over, replacing one in progress. */
    private fun onAuthenticated(credentials: ClerkCredentials) {
        val gen = generation
        connectJob?.cancel()
        connectJob = scope.launch { connectAccount(credentials, gen) }
    }

    /**
     * Brings the account up on an authenticated client: the user record, this device's heartbeat,
     * the one-time merge of local data, the subscriptions, then the outbox. A call that fails is
     * tried again after [RETRY_MS] for as long as this sign-in lasts and the client stays
     * authenticated; the server answering "Not authenticated" hands over to the auth loop instead.
     */
    private suspend fun connectAccount(credentials: ClerkCredentials, gen: Int) {
        val convex = client ?: return
        while (gen == generation && authenticated) {
            try {
                CloudDiagnostics.event("connecting the account")
                user = convex.mutation<UserDto>("users:ensure")
                heartbeat()
                importLocalData(credentials.userId)
                if (gen != generation) return
                subscribe(gen)
                error = null
                CloudDiagnostics.event("account connected; subscriptions up")
                publish()
                flush()
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (gen != generation) return
                error = e.message
                CloudDiagnostics.convexError("account connection", e.message)
                Log.e(TAG, "account connection failed; retrying", e)
                publish()
                if (isAuthError(e)) {
                    authLost("account connection")
                    return
                }
                delay(RETRY_MS)
            }
        }
    }

    /**
     * The server treated a call as unauthenticated although the client believed it was signed in:
     * the Rust client's token refresh on a reconnect failed, or the identity expired. The auth loop
     * logs in again, which hands the client a fresh token and reruns the account connection.
     */
    private fun authLost(where: String) {
        if (authStale) return
        authStale = true
        CloudDiagnostics.serverAuthLost(where)
        nudge("server says not authenticated")
    }

    /** A subscription or call failed: shown as the sync issue, and recognised as a lost identity when it is one. */
    private fun noteFailure(where: String, e: Throwable) {
        error = e.message
        CloudDiagnostics.convexError(where, e.message)
        if (isAuthError(e)) authLost(where)
    }

    /** A subscription delivered: the identity the server holds works, whatever happened before. */
    private fun delivered(name: String) {
        CloudDiagnostics.subscriptionData(name)
        staleStreak = 0
    }

    private suspend fun importLocalData(userId: String) {
        val convex = client ?: return
        val s = settings.get()
        if (s.importedForUserId == userId) return
        val entries = s.dictionaryEntries.filter { it.word.isNotBlank() }
        val snippets = s.snippets.filter { it.trigger.isNotBlank() && it.content.isNotBlank() }
        val rules = s.appRules.filter { it.match.isNotBlank() }
        Log.i(TAG, "merging local data into the account: ${entries.size} words, ${snippets.size} snippets, ${rules.size} rules")
        for (chunk in entries.chunked(IMPORT_CHUNK)) {
            convex.mutation("dictionary:importMany", mapOf(
                "entries" to chunk.map { e ->
                    buildMap<String, Any?> {
                        put("word", e.word)
                        put("aliases", e.aliases)
                        put("fuzzy", e.fuzzy)
                        if (e.createdAt > 0) put("createdAt", e.createdAt.toDouble())
                    }
                }
            ))
        }
        for (chunk in snippets.chunked(IMPORT_CHUNK)) {
            convex.mutation("snippets:importMany", mapOf("snippets" to chunk.map { snippetArgs(it) }))
        }
        for (chunk in rules.chunked(IMPORT_CHUNK)) {
            convex.mutation("appRules:importMany", mapOf("rules" to chunk.map { appRuleArgs(it) }))
        }
        if (s.onboardingComplete) {
            convex.mutation("users:completeOnboarding", mapOf("version" to ONBOARDING_VERSION))
        }
        // Dictations made before signing in count towards the account, like the desktop app does.
        if (s.stats.totalSessions > 0) {
            convex.mutation<StatsDto>("stats:importLocal", mapOf(
                "totalWords" to s.stats.totalWords.toDouble(),
                "totalSessions" to s.stats.totalSessions.toDouble(),
                "totalSpeechMs" to s.stats.totalSpeechMs.toDouble(),
                "streakDays" to s.stats.streakDays.toDouble(),
                "lastSessionDay" to s.stats.lastSessionDay
            ))
        }
        settings.update(SettingsOrigin.CLOUD) { it.copy(importedForUserId = userId) }
    }

    // ---- subscriptions ------------------------------------------------------------------------

    private fun subscribe(gen: Int) {
        val convex = client ?: return
        subscriptions?.cancel()
        subscriptions = scope.launch {
            launch {
                convex.subscribe<List<DictionaryEntryDto>>("dictionary:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { list ->
                        delivered("dictionary:list")
                        serverDictionary = list
                        outbox.update { SyncReducers.pruneAcked(it, list.map { d -> d.id }.toSet()) }
                        applyDerived()
                    }.onFailure { noteFailure("dictionary:list", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<List<SnippetDto>>("snippets:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { list ->
                        delivered("snippets:list")
                        serverSnippets = list
                        outbox.update { SyncReducers.pruneAcked(it, list.map { d -> d.id }.toSet()) }
                        applyDerived()
                    }.onFailure { noteFailure("snippets:list", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<List<AppRuleDto>>("appRules:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { list ->
                        delivered("appRules:list")
                        serverAppRules = list
                        outbox.update { SyncReducers.pruneAcked(it, list.map { d -> d.id }.toSet()) }
                        applyDerived()
                    }.onFailure { noteFailure("appRules:list", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<PreferencesDto?>("preferences:get").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { prefs ->
                        delivered("preferences:get")
                        serverPreferences = prefs
                        if (!preferencesLoaded) {
                            preferencesLoaded = true
                            // First contact: a device without account preferences pushes its own.
                            if (prefs == null) {
                                val local = StylePreferences.of(settings.get())
                                outbox.update { SyncReducers.queuePreferences(it, local, newOpId()) }
                                launch { flush() }
                            }
                        }
                        applyDerived()
                    }.onFailure { noteFailure("preferences:get", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<UserDto?>("users:me").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess {
                        delivered("users:me")
                        user = it
                    }.onFailure { noteFailure("users:me", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<List<DeviceDto>>("devices:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess {
                        delivered("devices:list")
                        devices = it
                    }.onFailure { noteFailure("devices:list", it) }
                    publish()
                }
            }
            launch {
                convex.subscribe<StatsDto?>("stats:get").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess {
                        delivered("stats:get")
                        serverStats = it
                    }.onFailure { noteFailure("stats:get", it) }
                    publish()
                }
            }
            launch { subscribeStatus(gen) }
        }
        stopHistorySubscription()
        updateHistorySubscription(gen)
    }

    /**
     * The managed-model status for today (UTC), asked again when the day changes so the rolling
     * windows (words this week, dictations today) and their reset times stay right. An instance
     * that does not accept the `day` argument yet answers with an argument error; then the status
     * is asked the old way, without windows.
     */
    private suspend fun subscribeStatus(gen: Int) = coroutineScope {
        val convex = client ?: return@coroutineScope
        while (gen == generation) {
            val withDay = !statusWithoutDay
            val args: Map<String, Any?> = if (withDay) mapOf("day" to InferenceStatusDto.currentUtcDay()) else emptyMap()
            val refused = CompletableDeferred<Unit>()
            val subscription = launch {
                convex.subscribe<InferenceStatusDto>("inference:status", args).collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess {
                        delivered("inference:status")
                        inference = it
                    }.onFailure { e ->
                        if (withDay && e.message?.contains("ArgumentValidationError", ignoreCase = true) == true) {
                            Log.i(TAG, "instance does not take a day for inference:status; asking without it")
                            statusWithoutDay = true
                            refused.complete(Unit)
                        } else {
                            Log.w(TAG, "inference status: ${e.message}")
                            CloudDiagnostics.convexError("inference:status", e.message)
                            if (isAuthError(e)) authLost("inference:status")
                        }
                    }
                    publish()
                }
            }
            // Until the day turns or the argument is refused (without the day there is no turning:
            // the wait only ends with the scope, on sign-out or a new generation).
            if (withDay) withTimeoutOrNull(InferenceStatusDto.msUntilNextUtcDay()) { refused.await() } else refused.await()
            subscription.cancel()
        }
    }

    /**
     * Mirror the account's recent dictations while the user has opted in and the account is
     * connected (desktop: `updateHistorySubscription`). The phone's own entries come back with its
     * device id and are left out: the local copies carry the timings and the recording. Off, the
     * mirror is dropped; the account keeps its copies until a device clears them.
     */
    private fun updateHistorySubscription(gen: Int = generation) {
        val convex = client
        val wanted = convex != null && authenticated && signedIn && settings.get().historySync
        if (!wanted) {
            if (historySubscription != null) {
                stopHistorySubscription()
                history.removeRemote()
            }
            return
        }
        if (historySubscription != null || convex == null) return
        val mine = settings.get().deviceId
        historySubscription = scope.launch {
            convex.subscribe<List<HistoryEntryDto>>("history:recent", mapOf("limit" to HISTORY_BACKLOG.toDouble())).collect { result ->
                if (gen != generation) return@collect
                result.onSuccess { list ->
                    delivered("history:recent")
                    history.mergeRemote(list.filter { it.deviceId != mine }.map(SyncReducers::historyFromRemote))
                }.onFailure { noteFailure("history:recent", it) }
                publish()
            }
        }
    }

    private fun stopHistorySubscription() {
        historySubscription?.cancel()
        historySubscription = null
    }

    private fun applyDerived() {
        val s = settings.get()
        val ops = outbox.ops
        val derived = SyncReducers.deriveDictionary(serverDictionary, s.dictionaryEntries, ops)
        val snippets = SyncReducers.deriveCollection(SyncReducers.snippetsSpec, serverSnippets, s.snippets, ops)
        val rules = SyncReducers.deriveCollection(SyncReducers.appRulesSpec, serverAppRules, s.appRules, ops)
        val remote = serverPreferences
        val pendingPrefs = ops.filterIsInstance<SyncOp.PreferencesUpdate>().lastOrNull()?.prefs
        applying = true
        try {
            settings.update(SettingsOrigin.CLOUD) { current ->
                var next = current.copy(dictionaryEntries = derived, snippets = snippets, appRules = rules)
                if (preferencesLoaded && remote != null) next = applyRemotePreferences(next, remote)
                if (pendingPrefs != null) next = applyRemotePreferences(next, pendingPrefs.toDto())
                next
            }
        } finally {
            applying = false
        }
        mirrorPrefs = StylePreferences.of(settings.get())
        // Another device flipped the account's history opt-in: follow it here.
        val historySync = settings.get().historySync
        if (historySync != s.historySync) {
            if (historySync) queueHistoryBacklog()
            updateHistorySubscription()
        }
    }

    // ---- local changes -> outbox ------------------------------------------------------------

    private fun onSettingsChange(previous: MurmurSettings, next: MurmurSettings, origin: SettingsOrigin) {
        if (origin == SettingsOrigin.CLOUD || applying) {
            mirrorPrefs = StylePreferences.of(next)
            return
        }
        if (!signedIn) {
            mirrorPrefs = StylePreferences.of(next)
            return
        }
        var touched = false
        val serverIds = serverDictionary?.map { it.id }?.toSet() ?: emptySet()
        val diff = SyncReducers.diffDictionary(previous.dictionaryEntries, next.dictionaryEntries)
        for (e in diff.added + diff.changed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueUpsert(
                    ops,
                    SyncOp.DictionaryUpsert(
                        id = newOpId(),
                        localId = e.id,
                        remoteId = SyncReducers.remoteIdFor(e.id, serverIds, ops),
                        entry = e
                    )
                )
            }
        }
        for (e in diff.removed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueRemove(ops, e.id, SyncReducers.remoteIdFor(e.id, serverIds, ops), newOpId())
            }
        }
        val snippetIds = serverSnippets?.map { it.id }?.toSet() ?: emptySet()
        val snips = SyncReducers.diffCollection(previous.snippets, next.snippets, { it.id }, SyncReducers::sameSnippet)
        for (x in snips.added + snips.changed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueUpsert(
                    ops,
                    SyncOp.SnippetUpsert(newOpId(), x.id, SyncReducers.remoteIdFor(x.id, snippetIds, ops), snippet = x)
                )
            }
        }
        for (x in snips.removed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueRemove(ops, SyncReducers.snippetsSpec, x.id, SyncReducers.remoteIdFor(x.id, snippetIds, ops), newOpId())
            }
        }
        val ruleIds = serverAppRules?.map { it.id }?.toSet() ?: emptySet()
        val rules = SyncReducers.diffCollection(previous.appRules, next.appRules, { it.id }, SyncReducers::sameAppRule)
        for (r in rules.added + rules.changed) {
            if (r.match.isBlank()) continue // the Style screen adds an empty rule first, then fills it in
            touched = true
            outbox.update { ops ->
                SyncReducers.queueUpsert(
                    ops,
                    SyncOp.AppRuleUpsert(newOpId(), r.id, SyncReducers.remoteIdFor(r.id, ruleIds, ops), rule = r)
                )
            }
        }
        for (r in rules.removed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueRemove(ops, SyncReducers.appRulesSpec, r.id, SyncReducers.remoteIdFor(r.id, ruleIds, ops), newOpId())
            }
        }
        val prefs = StylePreferences.of(next)
        val historyToggled = prefs.historySync != mirrorPrefs.historySync
        if (prefs != mirrorPrefs) {
            touched = true
            outbox.update { SyncReducers.queuePreferences(it, prefs, newOpId()) }
        }
        mirrorPrefs = prefs
        // The opt-in flipped here: the account learns of it with the preferences, and the phone's
        // recent dictations follow it up (on) or the other devices' entries go (off).
        if (historyToggled) {
            if (prefs.historySync) queueHistoryBacklog()
            updateHistorySubscription()
        }
        if (touched) {
            publish()
            scope.launch { flush() }
        }
    }

    /**
     * A change to History made on this phone (desktop: `onHistoryAdded`, `onHistoryDeleted`,
     * `onHistoryCleared`). Nothing leaves the phone unless the user opted in; entries that came
     * from other devices are never sent back; a change the cloud made is not echoed either.
     */
    private fun onHistoryEvent(event: HistoryEvent) {
        if (!signedIn || !settings.get().historySync) return
        when (event) {
            is HistoryEvent.Added -> queueHistoryEntry(event.entry)
            is HistoryEvent.Replaced -> queueHistoryEntry(event.entry)
            is HistoryEvent.Deleted -> {
                if (event.origin == HistoryOrigin.CLOUD) return
                outbox.update { it + SyncOp.HistoryRemove(newOpId(), event.id) }
                publish()
                scope.launch { flush() }
            }
            is HistoryEvent.Cleared -> {
                if (event.origin == HistoryOrigin.CLOUD) return
                outbox.update { SyncReducers.queueHistoryClear(it, newOpId()) }
                publish()
                scope.launch { flush() }
            }
        }
    }

    private fun queueHistoryEntry(entry: HistoryEntry) {
        if (entry.remote) return
        val push = SyncReducers.historyToPush(entry) ?: return
        outbox.update { SyncReducers.queueHistoryPush(it, push, newOpId()) }
        publish()
        scope.launch {
            delay(HISTORY_PUSH_DELAY_MS)
            flush()
        }
    }

    /**
     * Sync just turned on, here or on another device: the phone's recent dictations (its own, that
     * produced text) join the account. Sent right away; the desktop leaves its backlog for the next
     * flush, which on a phone that is put away could be a while.
     */
    private fun queueHistoryBacklog() {
        val local = history.entries.value
            .asSequence()
            .filter { !it.remote }
            .take(HISTORY_BACKLOG)
            .mapNotNull(SyncReducers::historyToPush)
            .toList()
        if (local.isEmpty()) return
        outbox.update { ops ->
            var next = ops
            for (entry in local) next = SyncReducers.queueHistoryPush(next, entry, newOpId())
            next
        }
        publish()
        scope.launch { flush() }
    }

    /** Called after every finished dictation. */
    fun recordSession(sessionId: String, words: Int, speechMs: Long) {
        if (!config.enabled || !signedIn || words <= 0) return
        outbox.update { it + SyncOp.StatsRecord(newOpId(), sessionId, words, speechMs, localDay()) }
        publish()
        scope.launch { flush() }
    }

    /** Account-level onboarding finished on this device. */
    fun completeOnboarding() {
        if (!config.enabled || !signedIn) return
        outbox.update { ops -> ops.filterNot { it is SyncOp.CompleteOnboarding } + SyncOp.CompleteOnboarding(newOpId()) }
        user = user?.copy(onboardingCompletedAt = System.currentTimeMillis().toDouble())
        publish()
        scope.launch { flush() }
    }

    /**
     * The user asked for a sync: whatever stands in the way is tried again now, and the reason is
     * reported when it cannot be. Not signed in, there is nothing to sync; unauthenticated, the
     * auth loop is woken (its failure, if any, becomes the sync issue); otherwise the outbox is
     * flushed, and a flush that cannot reach the server says so.
     */
    fun syncNow() {
        if (!config.enabled) return
        scope.launch {
            when {
                !signedIn -> {
                    CloudDiagnostics.syncRequest("nothing to do: not signed in")
                }
                !authenticated || authStale -> {
                    CloudDiagnostics.syncRequest("not authenticated with Convex; logging in again" + (authError?.let { " (last: $it)" }.orEmpty()))
                    error = null
                    publish()
                    nudge("sync now")
                }
                !connected && !online -> {
                    CloudDiagnostics.syncRequest("no network; ${outbox.pending} pending")
                    error = "No network connection"
                    publish()
                }
                else -> {
                    CloudDiagnostics.syncRequest("flushing ${outbox.pending} pending" + (if (!connected) " (websocket reconnecting)" else ""))
                    error = null
                    publish()
                    flush()
                }
            }
        }
    }

    /**
     * Cloud work threw outside every catch (the scope's exception handler brings it here): shown
     * as a sync issue on the Account screen instead of ending the process.
     */
    fun reportFailure(e: Throwable) {
        error = CloudBootstrap.describe(e)
        publish()
    }

    suspend fun signOut() {
        client?.logout(app)
    }

    /** Erase the account's data in the cloud; the subscriptions then empty the local mirror, as on the desktop. */
    suspend fun deleteMyData(): Result<Unit> {
        val convex = client ?: return Result.failure(IllegalStateException("Cloud is not configured"))
        if (!authenticated) return Result.failure(IllegalStateException("Not connected to your account"))
        return try {
            outbox.update { emptyList() }
            convex.mutation("users:deleteMyData")
            history.clear(HistoryOrigin.CLOUD)
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // ---- outbox flush -------------------------------------------------------------------------

    /**
     * Replays the outbox head to tail. An op the server refused for good is dropped; one whose
     * mutation ran but whose answer could not be read is finished too (the server has it); any
     * other failure stops the flush and books one retry in [RETRY_MS], replacing the one before
     * it, so a long outage never builds up a crowd of retries.
     */
    private suspend fun flush() {
        val convex = client ?: return
        if (!authenticated) return
        if (!flushMutex.tryLock()) return
        val gen = generation
        var sent = 0
        var dropped = 0
        var failure: String? = null
        try {
            flushRetry?.cancel()
            flushRetry = null
            while (gen == generation && authenticated) {
                val op = outbox.ops.firstOrNull { !it.isAcked } ?: break
                try {
                    send(convex, op)
                    if (gen != generation) break
                    sent++
                    error = null
                    applyDerived()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (gen != generation) break
                    if (isDecodeError(e)) {
                        // The mutation ran; only its answer was unreadable. Keeping the op would send it again forever.
                        Log.w(TAG, "${op::class.simpleName} ran but its answer could not be read; counting it done: ${e.message}")
                        CloudDiagnostics.event("${op::class.simpleName}: answer unreadable, counted done")
                        outbox.remove(op.id)
                        sent++
                        applyDerived()
                        continue
                    }
                    if (isPermanentError(e)) {
                        Log.w(TAG, "dropping ${op::class.simpleName}: ${e.message}")
                        CloudDiagnostics.event("${op::class.simpleName} refused by the server, dropped: ${e.message}")
                        outbox.remove(op.id)
                        dropped++
                        applyDerived()
                        continue
                    }
                    failure = e.message ?: CloudBootstrap.describe(e)
                    error = failure
                    Log.w(TAG, "sync failed, retrying in ${RETRY_MS / 1000}s: ${e.message}")
                    if (isAuthError(e)) {
                        authLost("flush of ${op::class.simpleName}")
                    } else {
                        flushRetry = scope.launch {
                            delay(RETRY_MS)
                            flush()
                        }
                    }
                    break
                }
            }
        } finally {
            flushMutex.unlock()
            CloudDiagnostics.flush(sent, dropped, failure)
            publish()
        }
    }

    private suspend fun send(convex: ConvexClientWithAuth<ClerkCredentials>, op: SyncOp) {
        when (op) {
            is SyncOp.DictionaryUpsert -> {
                val id = convex.mutation<String>("dictionary:upsert", buildMap {
                    if (op.remoteId != null) put("id", op.remoteId)
                    put("word", op.entry.word)
                    put("aliases", op.entry.aliases)
                    put("fuzzy", op.entry.fuzzy)
                    if (op.entry.createdAt > 0) put("createdAt", op.entry.createdAt.toDouble())
                })
                outbox.update { SyncReducers.ack(it, op.id, id) }
                return
            }
            is SyncOp.DictionaryRemove ->
                convex.mutation<Boolean>("dictionary:remove", mapOf("id" to op.remoteId))
            is SyncOp.SnippetUpsert -> {
                val id = convex.mutation<String>("snippets:upsert", buildMap {
                    if (op.remoteId != null) put("id", op.remoteId)
                    putAll(snippetArgs(op.snippet))
                })
                outbox.update { SyncReducers.ack(it, op.id, id) }
                return
            }
            is SyncOp.SnippetRemove ->
                convex.mutation<Boolean>("snippets:remove", mapOf("id" to op.remoteId))
            is SyncOp.AppRuleUpsert -> {
                val id = convex.mutation<String>("appRules:upsert", buildMap {
                    if (op.remoteId != null) put("id", op.remoteId)
                    putAll(appRuleArgs(op.rule))
                })
                outbox.update { SyncReducers.ack(it, op.id, id) }
                return
            }
            is SyncOp.AppRuleRemove ->
                convex.mutation<Boolean>("appRules:remove", mapOf("id" to op.remoteId))
            is SyncOp.PreferencesUpdate ->
                convex.mutation<PreferencesDto>("preferences:update", op.prefs.patchArgs(null))
            is SyncOp.StatsRecord -> {
                // The answer is the account's totals (StatsDto, with the last day as a string):
                // read as such, it refreshes the stats shown; read as numbers only it failed to
                // decode after every send and wedged the outbox at this op for good.
                val totals = convex.mutation<StatsDto>("stats:recordSession", mapOf(
                    "words" to op.words.toDouble(),
                    "speechMs" to op.speechMs.toDouble(),
                    "day" to op.day,
                    "sessionId" to op.sessionId
                ))
                serverStats = totals
            }
            is SyncOp.CompleteOnboarding ->
                convex.mutation<UserDto>("users:completeOnboarding", mapOf("version" to ONBOARDING_VERSION))
            is SyncOp.HistoryPush ->
                convex.mutation<Map<String, Double>>("history:push", SyncReducers.historyPushArgs(settings.get().deviceId, op.entries))
            is SyncOp.HistoryRemove ->
                convex.mutation<Boolean>("history:remove", mapOf("entryId" to op.entryId))
            is SyncOp.HistoryClear ->
                convex.mutation<Double>("history:clear")
        }
        outbox.remove(op.id)
    }

    private suspend fun heartbeat() {
        val convex = client ?: return
        val s = settings.get()
        convex.mutation<DeviceDto>("devices:heartbeat", mapOf(
            "deviceId" to s.deviceId,
            "name" to (Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"),
            "platform" to "android",
            "appVersion" to BuildConfig.VERSION_NAME
        ))
    }

    /**
     * The status for the screens. Before the client is authenticated the WebSocket says nothing
     * (the Rust client only opens it once it has a token), so the auth loop's state comes first:
     * its last failure is the sync issue, else it is connecting. Authenticated, the socket counts:
     * opening for the first time is connecting, dropped after being up is offline. No network at
     * all is offline whatever else is going on.
     */
    private fun publish() {
        val pending = outbox.pending
        val phase = when {
            !config.enabled -> SyncPhase.DISABLED
            !signedIn -> SyncPhase.SIGNED_OUT
            !online -> SyncPhase.OFFLINE
            !authenticated && authError != null -> SyncPhase.ERROR
            !authenticated -> SyncPhase.CONNECTING
            !connected && !everConnected -> SyncPhase.CONNECTING
            !connected -> SyncPhase.OFFLINE
            error != null -> SyncPhase.ERROR
            pending > 0 -> SyncPhase.SYNCING
            else -> SyncPhase.SYNCED
        }
        // While the client cannot authenticate, that is the issue to show, whatever a subscription said before.
        val shown = if (!authenticated && authError != null) authError else error
        val stats = serverStats?.let { SyncReducers.deriveStats(settings.get().stats, it, outbox.ops) }
        _status.value = SyncStatus(phase, signedIn, authenticated, connected, pending, user, devices, shown, stats, inference)
        CloudDiagnostics.sync(phase.name.lowercase(), pending, outbox.ops.firstOrNull { !it.isAcked }?.let { it::class.simpleName })
    }

    companion object {
        @Volatile private var instance: CloudSync? = null

        /** Records per import call; the backend takes at most `LIMITS.batch` (500). */
        private const val IMPORT_CHUNK = 500

        /** `snippets:upsert` / `snippets:importMany` arguments for one snippet; optionals only when set. */
        fun snippetArgs(s: Snippet): Map<String, Any?> = buildMap {
            put("trigger", s.trigger)
            put("content", s.content)
            if (s.createdAt > 0) put("createdAt", s.createdAt.toDouble())
        }

        /** `appRules:upsert` / `appRules:importMany` arguments for one rule; `v.optional` fields are omitted, never null. */
        fun appRuleArgs(r: AppRule): Map<String, Any?> = buildMap {
            put("match", r.match)
            put("tone", r.tone.id)
            r.formatting?.let { put("formatting", it.id) }
            r.trailingSpace?.let { put("trailingSpace", it) }
            r.instructions?.takeIf { it.isNotBlank() }?.let { put("instructions", it) }
            r.speed?.let { put("speed", it.id) }
            if (r.createdAt > 0) put("createdAt", r.createdAt.toDouble())
        }

        /** Who is signed in with Clerk, once it is ready: the user id, or null for nobody. */
        private fun clerkAccount(): Flow<String?> =
            combine(Clerk.isInitialized, Clerk.userFlow) { ready, user -> ready to user?.id }
                .filter { it.first }
                .map { it.second }

        /**
         * The app's engine, on the Convex [client] and [scope] the bootstrap made (see
         * [CloudBootstrap]: the client's construction and this call each run behind its catch).
         */
        fun init(
            context: Context,
            config: CloudConfig,
            settings: SettingsStore,
            history: HistoryStore,
            client: ConvexClientWithAuth<ClerkCredentials>,
            scope: CoroutineScope
        ): CloudSync =
            instance ?: synchronized(this) {
                instance ?: CloudSync(context.applicationContext, config, settings, history, clerkAccount(), scope, client).also {
                    instance = it
                    it.start()
                }
            }

        fun get(): CloudSync? = instance

        fun localDay(now: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(now)

        /** Server-side validation/ownership errors: retrying would wedge the queue. */
        fun isPermanentError(e: Throwable): Boolean {
            val message = e.message ?: return false
            if (isAuthError(e)) return false
            return e is dev.convex.android.ConvexError ||
                Regex("Server Error|ArgumentValidationError|Uncaught Error|ReturnsValidationError", RegexOption.IGNORE_CASE)
                    .containsMatchIn(message)
        }

        /** The server ran the function as nobody: the client's identity is gone or was never accepted. */
        fun isAuthError(e: Throwable): Boolean =
            e.message?.contains("Not authenticated", ignoreCase = true) == true

        /**
         * The mutation ran on the server, but its answer could not be decoded into the type asked
         * for (the Convex client's [InternalError] from `jsonApi.decodeFromString`): the op is done
         * as far as the server is concerned, and sending it again would only run it again.
         */
        fun isDecodeError(e: Throwable): Boolean =
            e is InternalError && e.message?.startsWith("Failed to decode JSON") == true

        /** How long the auth loop waits after its [attempt]th failure in a row. */
        fun authRetryDelay(attempt: Int): Long {
            var delay = AUTH_RETRY_FIRST_MS
            repeat((attempt - 1).coerceIn(0, 10)) { delay = (delay * 2).coerceAtMost(AUTH_RETRY_MAX_MS) }
            return delay.coerceAtMost(AUTH_RETRY_MAX_MS)
        }
    }
}

private fun StylePreferences.toDto() = PreferencesDto(
    formatting = FormattingPreferencesDto(
        mode = mode,
        tone = tone,
        trailingSpace = trailingSpace,
        llmInstructions = llmInstructions
    ),
    language = language,
    sync = SyncPreferencesDto(history = historySync)
)
