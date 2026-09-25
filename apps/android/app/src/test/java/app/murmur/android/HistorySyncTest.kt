package app.murmur.android

import android.content.Context
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.StageTimings
import app.murmur.android.settings.SettingsStore
import dev.convex.android.ConvexClientWithAuth
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The whole sync engine against a fake Convex backend ([FakeConvex]), signed in as one account:
 * what leaves the phone about its dictations and what arrives from the account's other devices,
 * under the same rules as the desktop engine (apps/desktop/src/main/cloud/sync-engine.ts).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HistorySyncTest {

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var context: Context
    private lateinit var settings: SettingsStore
    private lateinit var history: HistoryStore
    private val convex = FakeConvex()
    private val account = MutableStateFlow<String?>(null)
    private val config = CloudConfig.resolve("https://a.convex.cloud", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k", "")
    private val mine: String get() = settings.get().deviceId

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("murmur_sync_outbox", Context.MODE_PRIVATE).edit().clear().commit()
        settings = SettingsStore(context)
        // The pre-account merge is another story (dictionary, snippets, rules); this account has had it.
        settings.update { it.copy(onboardingComplete = true, importedForUserId = "user_1") }
        history = HistoryStore(File(folder.root, "history.json"))
        convex.results["users:ensure"] = { """{"id":"u1","clerkId":"user_1","plan":"free","createdAt":1}""" }
        convex.results["devices:heartbeat"] = {
            """{"id":"dv1","deviceId":"$mine","name":"Phone","platform":"android","appVersion":"0.5.4","lastSeenAt":1,"createdAt":1}"""
        }
        convex.results["preferences:update"] = { """{"updatedAt":1}""" }
        convex.results["history:push"] = { """{"inserted":1,"pruned":0}""" }
        convex.results["history:remove"] = { "true" }
        convex.results["history:clear"] = { "0" }
    }

    private fun entry(id: String, at: Long, text: String = "Hello from the phone $id.", recording: String? = null) = HistoryEntry(
        id = id,
        createdAt = at,
        rawText = "um hello from the phone $id",
        finalText = text,
        wordCount = 5,
        speechMs = 1800,
        appName = "Messages",
        provider = "openai-compatible",
        model = "whisper-1",
        injected = true,
        llmUsed = true,
        llm = LlmOutcome.USED,
        stages = listOf("capitalize"),
        timings = StageTimings(recordMs = 1800, sttMs = 640, formatMs = 3, llmMs = 410, injectMs = 25, totalMs = 1090),
        recording = recording
    )

    private fun failed(id: String, at: Long) =
        entry(id, at).copy(finalText = "", wordCount = 0, injected = false, llmUsed = false, llm = null, error = "Nothing heard", recording = "$id.wav")

    private fun remoteJson(entryId: String, deviceId: String, deviceName: String?, at: Long, text: String) = buildString {
        append("""{"id":"h-$entryId","entryId":"$entryId","deviceId":"$deviceId",""")
        if (deviceName != null) append(""""deviceName":"$deviceName",""")
        append(""""createdAt":$at,"mode":"hold","rawText":"um $text","finalText":"$text","wordCount":4,"speechMs":900,""")
        append(""""appName":"Slack","provider":"openai-compatible","model":"whisper-1","llmUsed":true}""")
    }

    /** The engine on the test's scheduler, its Convex client talking to [convex]. */
    private fun TestScope.engine(): CloudSync {
        val client = ConvexClientWithAuth(config.convexUrl, FakeClerk("user_1"), backgroundScope, convex.factory())
        return CloudSync(context, config, settings, history, account, backgroundScope, client).also { it.start() }
    }

    /** Let everything due within the next second run: the push batching delay is 250 ms, the retry 15 s. */
    private fun TestScope.settle(ms: Long = 1_000) {
        advanceTimeBy(ms)
        runCurrent()
    }

    /** Sign in, connect, and let the account answer with no preferences yet (the phone pushes its own). */
    private fun TestScope.signIn(): CloudSync {
        val engine = engine()
        account.value = "user_1"
        settle()
        convex.connect()
        settle()
        convex.send("preferences:get", "null")
        settle()
        return engine
    }

    private fun pushedIds(): List<List<String>> =
        convex.calls("history:push").map { call -> call.args["entries"]!!.jsonArray.map { it.jsonObject["entryId"]!!.jsonPrimitive.content } }

    @Test
    fun `off by default, nothing about history leaves the phone`() = runTest {
        history.add(entry("a", 1_000, recording = "a.wav"))
        val engine = signIn()
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
        assertFalse(settings.get().historySync)

        history.add(entry("b", 2_000))
        history.replace(entry("b", 2_000, text = "Hello again."))
        history.delete("a")
        history.clear()
        settle()

        assertTrue("no history function was called: ${convex.calls.map { it.name }}", convex.calls.none { it.name.startsWith("history:") })
        assertFalse(convex.subscribed("history:recent"))
        // The phone's own preferences went up on first contact, with the opt-in off.
        val prefs = convex.calls("preferences:update").single().args
        assertEquals("false", prefs["sync"]!!.jsonObject["history"]!!.jsonPrimitive.content)
        assertEquals("smart", prefs["formatting"]!!.jsonObject["mode"]!!.jsonPrimitive.content)
    }

    @Test
    fun `on, the phone's dictations go up and the other devices' come down with their device`() = runTest {
        history.add(entry("a", 1_000, recording = "a.wav"))
        history.add(failed("f", 1_500))
        val engine = signIn()

        settings.update { it.copy(historySync = true) }
        settle()

        // The opt-in reaches the account with the preferences, and the backlog follows: the
        // dictation that produced text, not the failed one; text and facts, no audio.
        val prefs = convex.calls("preferences:update").last().args
        assertEquals("true", prefs["sync"]!!.jsonObject["history"]!!.jsonPrimitive.content)
        assertEquals(listOf(listOf("a")), pushedIds())
        val push = convex.calls("history:push").single().args
        assertEquals(mine, push["deviceId"]!!.jsonPrimitive.content)
        val sent = push["entries"]!!.jsonArray.single().jsonObject
        assertEquals("Hello from the phone a.", sent["finalText"]!!.jsonPrimitive.content)
        assertEquals("um hello from the phone a", sent["rawText"]!!.jsonPrimitive.content)
        assertEquals("hands-free", sent["mode"]!!.jsonPrimitive.content)
        assertEquals("Messages", sent["appName"]!!.jsonPrimitive.content)
        assertEquals(5.0, sent["wordCount"]!!.jsonPrimitive.content.toDouble(), 0.0)
        assertEquals(1800.0, sent["speechMs"]!!.jsonPrimitive.content.toDouble(), 0.0)
        assertEquals(
            setOf("entryId", "createdAt", "mode", "rawText", "finalText", "wordCount", "speechMs", "appName", "provider", "model", "llmUsed"),
            sent.keys
        )
        // The account's recent dictations are wanted from now on, the desktop's 200 of them.
        assertTrue(convex.subscribed("history:recent"))
        assertEquals("200.0", convex.subscriptionArgs("history:recent")!!["limit"])

        // A new dictation follows on its own; a burst is one request.
        history.add(entry("b", 3_000))
        history.add(entry("c", 3_100))
        settle()
        assertEquals(listOf(listOf("a"), listOf("b", "c")), pushedIds())
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)

        // The server answers with everything it has: this phone's own entry among the others'.
        convex.send(
            "history:recent",
            "[" + listOf(
                remoteJson("d1", "desk", "Ben's desk", 5_000, "Hello from the desk."),
                remoteJson("a", mine, "Phone", 1_000, "Hello from the phone a."),
                remoteJson("d2", "gone", null, 2_500, "From a device since removed.")
            ).joinToString(",") + "]"
        )
        settle()
        assertEquals(listOf("d1", "c", "b", "d2", "f", "a"), history.entries.value.map { it.id })
        val desk = history.get("d1")!!
        assertTrue(desk.remote)
        assertEquals("desk", desk.deviceId)
        assertEquals("Ben's desk", desk.deviceName)
        assertEquals("Hello from the desk.", desk.finalText)
        assertEquals("Slack", desk.appName)
        assertTrue(desk.injected)
        assertEquals(LlmOutcome.USED, desk.llm)
        assertEquals(900L, desk.timings.recordMs)
        assertEquals(0L, desk.timings.totalMs)
        assertNull(desk.recording)
        // A device the account no longer lists has no name; History says "other device".
        val gone = history.get("d2")!!
        assertTrue(gone.remote)
        assertNull(gone.deviceName)
        // This phone's own copy is the one that stays: recording, timings and all.
        val own = history.get("a")!!
        assertFalse(own.remote)
        assertEquals("a.wav", own.recording)
        assertEquals(1090L, own.timings.totalMs)
        // Nothing that came down is sent back up.
        assertEquals(listOf(listOf("a"), listOf("b", "c")), pushedIds())
    }

    @Test
    fun `a delete or a clear here reaches the account, and an entry gone upstream leaves the phone`() = runTest {
        settings.update { it.copy(historySync = true) }
        history.add(entry("a", 1_000))
        signIn()
        convex.send("history:recent", "[" + remoteJson("d1", "desk", "Ben's desk", 5_000, "One.") + "," + remoteJson("d2", "desk", "Ben's desk", 6_000, "Two.") + "]")
        settle()
        assertEquals(listOf("d2", "d1", "a"), history.entries.value.map { it.id })

        // Deleting a synced entry here deletes it for every device; so does deleting one of this phone's.
        history.delete("d1")
        history.delete("a")
        settle()
        assertEquals(listOf("d1", "a"), convex.calls("history:remove").map { it.args["entryId"]!!.jsonPrimitive.content })
        assertEquals(listOf("d2"), history.entries.value.map { it.id })

        // Deleted on the desk: the account's list no longer has it, and neither does the phone.
        convex.send("history:recent", "[]")
        settle()
        assertTrue(history.entries.value.isEmpty())

        // Clear all: the pushes still waiting are pointless, one clear goes instead.
        history.add(entry("b", 7_000))
        history.clear()
        settle()
        assertEquals(1, convex.calls("history:clear").size)
        assertTrue(pushedIds().flatten().none { it == "b" })
        assertTrue(convex.calls.indexOfLast { it.name == "history:clear" } > convex.calls.indexOfLast { it.name == "history:remove" })
    }

    @Test
    fun `the opt-in is the account's, flipped on another device it is followed here`() = runTest {
        history.add(entry("a", 1_000))
        signIn()
        assertFalse(convex.subscribed("history:recent"))

        // The desktop turned it on: the phone's backlog goes up and the mirror starts.
        convex.send("preferences:get", """{"sync":{"history":true},"updatedAt":2}""")
        settle()
        assertTrue(settings.get().historySync)
        assertEquals(listOf(listOf("a")), pushedIds())
        assertTrue(convex.subscribed("history:recent"))
        convex.send("history:recent", "[" + remoteJson("d1", "desk", "Ben's desk", 5_000, "One.") + "]")
        settle()
        assertEquals(listOf("d1", "a"), history.entries.value.map { it.id })

        // Turned off again there: the other devices' entries leave this phone, the phone's own stay,
        // the account keeps its copies, and nothing new goes up.
        convex.send("preferences:get", """{"sync":{"history":false},"updatedAt":3}""")
        settle()
        assertFalse(settings.get().historySync)
        assertFalse(convex.subscribed("history:recent"))
        assertEquals(listOf("a"), history.entries.value.map { it.id })
        assertTrue(convex.calls.none { it.name == "history:clear" || it.name == "history:remove" })
        history.add(entry("b", 8_000))
        settle()
        assertEquals(listOf(listOf("a")), pushedIds())
    }

    @Test
    fun `turning it off here drops the mirror and keeps the account's copies`() = runTest {
        settings.update { it.copy(historySync = true) }
        history.add(entry("a", 1_000))
        val engine = signIn()
        convex.send("history:recent", "[" + remoteJson("d1", "desk", "Ben's desk", 5_000, "One.") + "]")
        settle()
        assertEquals(listOf("d1", "a"), history.entries.value.map { it.id })

        settings.update { it.copy(historySync = false) }
        settle()
        assertEquals("false", convex.calls("preferences:update").last().args["sync"]!!.jsonObject["history"]!!.jsonPrimitive.content)
        assertFalse(convex.subscribed("history:recent"))
        assertEquals(listOf("a"), history.entries.value.map { it.id })
        assertTrue(convex.calls.none { it.name == "history:clear" || it.name == "history:remove" })
        assertEquals(SyncPhase.SYNCED, engine.status.value.phase)
    }

    @Test
    fun `signing out clears the account's data from the phone, the opt-in with it`() = runTest {
        settings.update { it.copy(historySync = true) }
        history.add(entry("a", 1_000))
        val engine = signIn()
        convex.send("history:recent", "[" + remoteJson("d1", "desk", "Ben's desk", 5_000, "One.") + "]")
        settle()
        val before = convex.calls.size

        account.value = null
        settle()
        assertEquals(SyncPhase.SIGNED_OUT, engine.status.value.phase)
        assertFalse(settings.get().historySync)
        assertTrue(history.entries.value.isEmpty())
        assertFalse(convex.subscribed("history:recent"))
        // Nothing was sent on the way out: the clear is the phone's, not the account's.
        assertEquals(before, convex.calls.size)
        assertEquals(0, engine.status.value.pendingOps)
    }
}
