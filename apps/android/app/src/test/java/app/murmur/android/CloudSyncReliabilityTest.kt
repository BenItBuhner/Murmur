package app.murmur.android

import android.content.Context
import android.net.ConnectivityManager
import app.murmur.android.cloud.ClerkCredentials
import app.murmur.android.cloud.CloudBootGuard
import app.murmur.android.cloud.CloudBootstrap
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudDiagnostics
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.StatsDto
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.history.HistoryStore
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.Tone
import app.murmur.android.ui.syncLabel
import dev.convex.android.AuthProvider
import dev.convex.android.ClientException
import dev.convex.android.ConvexClientWithAuth
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

/**
 * The sync engine against a fake Convex backend and a Clerk that fails when told to, in each of the
 * ways the phone was found stuck: the first token request failing (or refused while the cloud was
 * still being published), the WebSocket dropping, the server losing the client's identity after a
 * reconnect, an outbox head whose answer never decoded, a restart with a full outbox, and Sync now
 * while any of that is going on. Each must end with the account connected and the outbox empty.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CloudSyncReliabilityTest {

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var context: Context
    private lateinit var settings: SettingsStore
    private lateinit var history: HistoryStore
    private val convex = FakeConvex()
    private val account = MutableStateFlow<String?>(null)
    private val config = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "")
    private val mine: String get() = settings.get().deviceId

    /** The totals as the server returns them (`statsDtoValidator`): numbers and the last day as a string. */
    private val statsJson = """{"totalWords":5,"totalSessions":1,"totalSpeechMs":1800,"streakDays":1,"lastSessionDay":"2026-09-30","updatedAt":1}"""

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("murmur_sync_outbox", Context.MODE_PRIVATE).edit().clear().commit()
        settings = SettingsStore(context)
        // The pre-account merge is another story; this account has had it.
        settings.update { it.copy(onboardingComplete = true, importedForUserId = "user_1") }
        history = HistoryStore(File(folder.root, "history.json"))
        CloudDiagnostics.reset()
        script(convex)
    }

    @After
    fun tearDown() {
        CloudBootstrap.reset()
        CloudBootGuard(context).disarm()
    }

    private fun script(convex: FakeConvex) {
        convex.results["users:ensure"] = { """{"id":"u1","clerkId":"user_1","plan":"free","createdAt":1}""" }
        convex.results["devices:heartbeat"] = {
            """{"id":"dv1","deviceId":"$mine","name":"Phone","platform":"android","appVersion":"0.6.5","lastSeenAt":1,"createdAt":1}"""
        }
        convex.results["preferences:update"] = { """{"updatedAt":1}""" }
        convex.results["stats:recordSession"] = { statsJson }
    }

    /** The engine on the test's scheduler, its Convex client talking to [convex] through [clerk]. */
    private fun TestScope.engine(clerk: AuthProvider<ClerkCredentials>, convex: FakeConvex = this@CloudSyncReliabilityTest.convex): CloudSync {
        val client = ConvexClientWithAuth(config.convexUrl, clerk, backgroundScope, convex.factory())
        return CloudSync(context, config, settings, history, account, backgroundScope, client).also { it.start() }
    }

    /** Let everything due within [ms] of virtual time run. */
    private fun TestScope.settle(ms: Long = 1_000) {
        advanceTimeBy(ms)
        runCurrent()
    }

    /** Sign in on a working Clerk, raise the socket, answer the first preferences read. */
    private fun TestScope.signIn(clerk: AuthProvider<ClerkCredentials> = FakeClerk("user_1")): CloudSync {
        val engine = engine(clerk)
        account.value = "user_1"
        settle(0)
        convex.connect()
        settle()
        convex.send("preferences:get", """{"updatedAt":1}""")
        settle()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        return engine
    }

    @Test
    fun `a first login that fails is tried again with backoff until it succeeds`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 2)
        val engine = engine(clerk)
        account.value = "user_1"
        settle(0)
        // The first request failed: said so, nothing reached the server, and the client is not written off.
        assertEquals(1, clerk.calls)
        assertEquals(SyncPhase.ERROR, engine.status.value.phase)
        assertEquals("Sync issue: Timed out getting a session token", syncLabel(engine.status.value))
        assertFalse(engine.status.value.authenticated)
        assertTrue(convex.calls.isEmpty())
        // Two seconds later it asks again; four seconds after that again, and that one works.
        settle(1_999)
        assertEquals(1, clerk.calls)
        settle(1)
        assertEquals(2, clerk.calls)
        assertEquals(SyncPhase.ERROR, engine.status.value.phase)
        settle(3_999)
        assertEquals(2, clerk.calls)
        settle(1)
        assertEquals(3, clerk.calls)
        assertTrue(engine.status.value.authenticated)
        assertNull(engine.status.value.error)
        // Authenticated, the account comes up: the user record, this device, the subscriptions.
        assertEquals(1, convex.calls("users:ensure").size)
        assertEquals(1, convex.calls("devices:heartbeat").size)
        assertTrue(convex.subscribed("inference:status"))
        assertTrue(convex.subscribed("devices:list"))
        // The socket has not reported itself up yet: connecting, not offline.
        assertEquals(SyncPhase.CONNECTING, engine.status.value.phase)
        convex.connect()
        settle()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        assertTrue(CloudDiagnostics.report(context).contains("convex login attempt 3: ok"))
    }

    @Test
    fun `a token refused while the cloud is still being published does not leave the client unauthenticated`() {
        // The engine's first act on a cold start is to ask Clerk for a token, from a background
        // thread, while the bootstrap is still publishing the cloud as ready. A provider that
        // refuses until then (as the app's did) fails that first attempt; the loop must ask again.
        val refusals = CountDownLatch(1)
        val grants = CountDownLatch(1)
        val probe = object : AuthProvider<ClerkCredentials> {
            @Volatile var refused = 0
            override suspend fun login(context: Context, onIdToken: (String?) -> Unit) = loginFromCache(onIdToken)
            override suspend fun loginFromCache(onIdToken: (String?) -> Unit): Result<ClerkCredentials> {
                if (!CloudBootstrap.state.value.usable) {
                    refused++
                    refusals.countDown()
                    return Result.failure(IllegalStateException("Murmur's server is not connected"))
                }
                grants.countDown()
                return Result.success(ClerkCredentials("user_1", "ann@example.com", "Ann Example", "jwt"))
            }
            override suspend fun logout(context: Context): Result<Void?> = Result.success(null)
            override fun extractIdToken(authResult: ClerkCredentials): String = authResult.token
        }
        // Unconfined: the engine's collectors run the moment they are launched, inside the bootstrap.
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var engine: CloudSync? = null
        val steps = CloudBootstrap.Steps(
            initClerk = { _, _ -> },
            createClient = { cfg, _ -> ConvexClientWithAuth(cfg.convexUrl, probe, scope, convex.factory()) },
            startSync = { ctx, cfg, client, _ ->
                CloudSync(ctx, cfg, settings, history, MutableStateFlow("user_1"), scope, client).also { it.start(); engine = it }
            }
        )
        try {
            CloudBootstrap.start(context, config, steps, CloudBootGuard(context))
            assertTrue("the provider was asked during the boot and refused", refusals.await(5, TimeUnit.SECONDS))
            assertEquals(1, probe.refused)
            // Within the first backoff (2 s) the engine asks again, now that the cloud is published, and gets its token.
            assertTrue("the engine asked again on its own", grants.await(10, TimeUnit.SECONDS))
            val deadline = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < deadline && convex.calls("users:ensure").isEmpty()) Thread.sleep(20)
            assertEquals(1, convex.calls("users:ensure").size)
            assertTrue(engine!!.status.value.authenticated)
            assertEquals(1, probe.refused)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `the network coming back or the app coming to the front ends the wait early`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 10)
        val engine = engine(clerk)
        account.value = "user_1"
        settle(0)
        assertEquals(1, clerk.calls)
        // The device gets its network back: the loop asks again at once instead of in two seconds.
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val callbacks = shadowOf(cm).networkCallbacks.toList()
        assertEquals(1, callbacks.size)
        callbacks.single().onAvailable(ShadowNetwork.newInstance(7))
        settle(0)
        assertEquals(2, clerk.calls)
        // So does the app coming to the front.
        engine.onAppVisible()
        settle(0)
        assertEquals(3, clerk.calls)
        // Nothing else happened in between: the timers alone would not have asked yet.
        settle(1_000)
        assertEquals(3, clerk.calls)
    }

    @Test
    fun `Sync now logs in again at once and reports why it cannot`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 100, reason = "Error occurred with unknown message.")
        val engine = engine(clerk)
        account.value = "user_1"
        settle(0)
        assertEquals(1, clerk.calls)
        assertEquals("Sync issue: Error occurred with unknown message.", syncLabel(engine.status.value))
        engine.syncNow()
        settle(0)
        assertEquals("the tap asked Clerk again without waiting", 2, clerk.calls)
        assertEquals("Sync issue: Error occurred with unknown message.", syncLabel(engine.status.value))
        assertTrue(CloudDiagnostics.report(context).contains("sync now: not authenticated with Convex; logging in again"))
        // Clerk recovers: the next tap gets through, and the account comes up.
        clerk.failures = 0
        engine.syncNow()
        settle(0)
        assertEquals(3, clerk.calls)
        assertTrue(engine.status.value.authenticated)
        assertEquals(1, convex.calls("users:ensure").size)
        convex.connect()
        settle()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        // Authenticated and up, Sync now flushes; with nothing waiting it stays synced.
        engine.syncNow()
        settle()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
    }

    @Test
    fun `the server losing the client's identity makes it log in again and rebuild the account`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 0)
        val engine = signIn(clerk)
        assertEquals(1, clerk.calls)
        assertEquals(1, convex.authCallbacksSet)
        assertEquals(1, convex.calls("users:ensure").size)
        // A token refresh on a reconnect failed inside the Rust client: the server now runs the
        // subscriptions as nobody, and our functions refuse.
        convex.fail("users:me", "[Request ID: 6f1] Server Error Uncaught Error: Not authenticated at getCurrentUser")
        settle(0)
        assertEquals("a fresh login, at once", 2, clerk.calls)
        assertEquals("the client got a new token callback", 2, convex.authCallbacksSet)
        assertEquals("the account connection ran again", 2, convex.calls("users:ensure").size)
        assertTrue(convex.subscribed("users:me"))
        assertTrue(engine.status.value.authenticated)
        convex.send("preferences:get", """{"updatedAt":1}""")
        settle()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        assertTrue(CloudDiagnostics.report(context).contains("server says not authenticated (users:me)"))

        // The same, but Clerk is down when asked: the issue is shown, the loop keeps trying, and it heals.
        clerk.failures = 1
        convex.fail("stats:get", "[Request ID: 6f2] Server Error Uncaught Error: Not authenticated at getCurrentUser")
        settle(0)
        assertEquals(3, clerk.calls)
        assertEquals(SyncPhase.ERROR, engine.status.value.phase)
        assertEquals("Sync issue: Timed out getting a session token", syncLabel(engine.status.value))
        settle(2_000)
        assertEquals(4, clerk.calls)
        assertTrue(engine.status.value.authenticated)
        assertEquals(3, convex.authCallbacksSet)
    }

    @Test
    fun `the socket dropping shows offline, what is dictated meanwhile waits, and the reconnect sends it`() = runTest {
        val engine = signIn()
        convex.disconnect()
        settle()
        assertEquals(SyncPhase.OFFLINE, engine.status.value.phase)
        assertEquals("Offline", syncLabel(engine.status.value))
        engine.recordSession("s1", words = 5, speechMs = 1800)
        settle()
        assertEquals(1, engine.status.value.pendingOps)
        assertEquals("Offline, 1 pending", syncLabel(engine.status.value))
        assertTrue("nothing reaches the server while the socket is down", convex.calls("stats:recordSession").isEmpty())
        // The Rust client brings the socket back: the flush that waited completes.
        convex.connect()
        settle()
        assertEquals(1, convex.calls("stats:recordSession").size)
        assertEquals(0, engine.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        // The totals the server answered with are the ones shown.
        assertEquals(5, engine.status.value.stats?.totalWords)
    }

    @Test
    fun `the stats answer decodes, so a dictation no longer wedges the outbox`() = runTest {
        // The server's answer to stats:recordSession has the last day as a string. Read as a map
        // of numbers (as the engine did) it never decoded: every send ran on the server and threw
        // here, the op stayed at the head of the outbox, and everything behind it waited forever.
        val json = Json { ignoreUnknownKeys = true }
        assertTrue(runCatching { json.decodeFromString<Map<String, Double?>>(statsJson) }.isFailure)
        assertEquals("2026-09-30", json.decodeFromString<StatsDto>(statsJson).lastSessionDay)

        val engine = signIn()
        engine.recordSession("s1", words = 5, speechMs = 1800)
        settle()
        assertEquals("sent once", 1, convex.calls("stats:recordSession").size)
        assertEquals(0, engine.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        assertEquals(5, engine.status.value.stats?.totalWords)
        // No retry timer is left behind to send it again.
        settle(60_000)
        assertEquals(1, convex.calls("stats:recordSession").size)
        // Everything queued behind a dictation goes too.
        engine.recordSession("s2", words = 3, speechMs = 900)
        settings.update { it.copy(tone = Tone.CASUAL) }
        settle()
        assertEquals(2, convex.calls("stats:recordSession").size)
        assertEquals(1, convex.calls("preferences:update").size)
        assertEquals(0, engine.status.value.pendingOps)
    }

    @Test
    fun `an answer that cannot be read counts the op as done instead of sending it forever`() = runTest {
        val engine = signIn()
        // The server ran the mutation; only its answer is not what the engine expects.
        convex.results["preferences:update"] = { "\"something new\"" }
        settings.update { it.copy(tone = Tone.CASUAL) }
        settle()
        assertEquals(1, convex.calls("preferences:update").size)
        assertEquals(0, engine.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        settle(60_000)
        assertEquals(1, convex.calls("preferences:update").size)
        assertTrue(CloudDiagnostics.report(context).contains("PreferencesUpdate: answer unreadable, counted done"))
    }

    @Test
    fun `a failure that is not final is retried once at a time, and an auth error hands over to the login loop`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 0)
        val engine = signIn(clerk)
        var broken = true
        convex.results["stats:recordSession"] = { if (broken) throw ClientException.InternalException("InternalError: WebSocket closed") else statsJson }
        engine.recordSession("s1", words = 5, speechMs = 1800)
        engine.recordSession("s2", words = 5, speechMs = 1800)
        engine.recordSession("s3", words = 5, speechMs = 1800)
        settle()
        assertEquals(SyncPhase.ERROR, engine.status.value.phase)
        assertEquals(3, engine.status.value.pendingOps)
        val failedSends = convex.calls("stats:recordSession").size
        assertTrue(failedSends in 1..3)
        // One retry timer, not one per dictation: fifteen seconds later exactly one more attempt.
        settle(15_000)
        assertEquals(failedSends + 1, convex.calls("stats:recordSession").size)
        broken = false
        settle(15_000)
        assertEquals(failedSends + 1 + 3, convex.calls("stats:recordSession").size)
        assertEquals(0, engine.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)

        // A mutation refused as unauthenticated is not retried blindly: the client logs in again
        // first, and a server that keeps refusing fresh logins is asked again with backoff, not in a loop.
        convex.results["stats:recordSession"] = { throw ClientException.ServerException("[Request ID: 9a] Server Error Uncaught Error: Not authenticated") }
        engine.recordSession("s4", words = 5, speechMs = 1800)
        settle(0)
        val logins = clerk.calls
        assertTrue("logged in again, a bounded number of times: $logins", logins in 2..3)
        assertEquals(logins, convex.authCallbacksSet)
        assertEquals(1, engine.status.value.pendingOps)
        settle(1_000)
        assertEquals("no new login within the backoff", logins, clerk.calls)
        convex.results["stats:recordSession"] = { statsJson }
        settle(60_000)
        assertEquals(0, engine.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
    }

    @Test
    fun `after a restart the outbox that could not be sent goes once the client is authenticated`() = runTest {
        // First life: Clerk never answers, so a dictation waits in the outbox.
        val stuck = engine(FlakyClerk("user_1", failures = Int.MAX_VALUE))
        account.value = "user_1"
        settle(0)
        stuck.recordSession("s1", words = 5, speechMs = 1800)
        settle()
        assertEquals(1, stuck.status.value.pendingOps)
        assertTrue(convex.calls.isEmpty())

        // Second life: a new process, the same phone (settings and outbox on disk), Clerk answering.
        val again = FakeConvex().also(::script)
        val fresh = engine(FakeClerk("user_1"), again)
        settle(0)
        again.connect()
        settle()
        again.send("preferences:get", """{"updatedAt":1}""")
        settle()
        assertEquals(1, again.calls("stats:recordSession").size)
        assertEquals(0, fresh.status.value.pendingOps)
        assertEquals(SyncPhase.SYNCED, fresh.status.value.phase)
    }

    @Test
    fun `the report says where each part stands`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 1)
        val engine = engine(clerk)
        account.value = "user_1"
        settle(0)
        settle(2_000)
        convex.connect()
        settle()
        engine.recordSession("s1", words = 5, speechMs = 1800)
        settle()
        val report = CloudDiagnostics.report(context)
        for (line in listOf("Boot:", "Boot guard:", "Clerk: ready, a user is signed in", "Convex WebSocket: connected", "Convex auth: authenticated",
            "Last login attempt: #2 ok", "Sync: synced · 0 pending", "Last flush:", "1 sent", "Network:", "Recent events")) {
            assertTrue("report lacks '$line':\n$report", report.contains(line))
        }
        assertTrue(report.contains("convex login attempt 1: failed: Timed out getting a session token"))
        assertFalse("no token in the report", report.contains("jwt-"))
        assertFalse("no address in the report", report.contains("ann@example.com"))
        assertNotNull(CloudDiagnostics.summary())
        assertTrue(CloudDiagnostics.summary().startsWith("WebSocket connected · authenticated · 0 pending"))
    }

    @Test
    fun `nothing of the loop runs for a signed-out device`() = runTest {
        val clerk = FlakyClerk("user_1", failures = 0)
        val engine = engine(clerk)
        settle(10_000)
        assertEquals(0, clerk.calls)
        assertEquals(SyncPhase.SIGNED_OUT, engine.status.value.phase)
        engine.syncNow()
        settle()
        assertEquals(0, clerk.calls)
        assertTrue(CloudDiagnostics.report(context).contains("sync now: nothing to do: not signed in"))
        // Signing out again stops the loop: Clerk is not asked after it.
        account.value = "user_1"
        settle(0)
        assertEquals(1, clerk.calls)
        account.value = null
        settle(0)
        settle(60_000)
        assertEquals(1, clerk.calls)
        assertEquals(SyncPhase.SIGNED_OUT, engine.status.value.phase)
    }
}
