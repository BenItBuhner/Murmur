package app.murmur.android

import android.app.Activity
import android.os.Looper
import android.widget.EditText
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.RecordingStore
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouter
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.TextInserter
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/**
 * Opt-in end-to-end dictation against a real Murmur gateway (a local `npx convex dev` deployment
 * that trusts a test JWT issuer, see convex/auth.config.ts), with only the microphone and the
 * accessibility node lookup swapped out: the bundled clip goes over real HTTP to
 * `/v1/audio/transcriptions`, the transcript to `/v1/format`, and the answer into a real `EditText`
 * through the same accessibility actions the service sends.
 *
 *   MURMUR_LIVE=1 MURMUR_GATEWAY_ORIGIN=http://127.0.0.1:3211 MURMUR_TEST_JWT_FILE=/tmp/android.jwt \
 *   ./gradlew :app:testDebugUnitTest --tests '*LiveGatewayTest*'
 *
 * MURMUR_LIVE_EXPECT picks the account's situation the token stands for:
 *   - `dictation` (default): a trial or Pro account; the model-formatted text lands in the field.
 *   - `refused`: an account past a free-tier cap (e.g. 500 words this week); the gateway's
 *     structured 429 reaches the pill with the limit, the recording is kept and Retry re-sends it.
 *   - `unformatted`: a Pro account past the soft fair-use cap; rule-based text lands with the
 *     limit on the success pill.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LiveGatewayTest {

    private fun env(name: String): String = System.getenv(name) ?: ""

    private val origin = env("MURMUR_GATEWAY_ORIGIN").trimEnd('/')
    private val tokenFile = env("MURMUR_TEST_JWT_FILE")
    private val expectation = env("MURMUR_LIVE_EXPECT").ifEmpty { "dictation" }

    @After
    fun tearDown() {
        DictationController.sink = null
        InferenceRouter.install(null)
    }

    /** A focused field in a real activity, the controller's sink pointed at it, Murmur models routed to the gateway. */
    private fun setUp(): Pair<Activity, EditText> {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        assumeTrue("Set MURMUR_GATEWAY_ORIGIN and MURMUR_TEST_JWT_FILE", origin.isNotEmpty() && File(tokenFile).isFile)

        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())

        val store = SettingsStore.get(activity)
        store.update {
            it.copy(
                sttSource = InferenceSource.MURMUR,
                llmSource = InferenceSource.MURMUR,
                formattingMode = FormattingMode.SMART,
                useFixtureAudio = true,
                onboardingComplete = true
            )
        }
        val config = CloudConfig(AccountMode.REQUIRED, origin.replace(":3211", ":3210"), "", convexSiteUrl = origin)
        InferenceRouter.install(
            InferenceRouter(
                config = config,
                settings = { store.get() },
                token = { File(tokenFile).readText().trim().ifEmpty { null } },
                signedIn = { true },
                managedAvailable = { true }
            )
        )

        val target = EditTextTarget(field)
        DictationController.sink = object : TextSink {
            override suspend fun insert(text: String, pressEnter: Boolean): String? =
                withContext(Dispatchers.Main.immediate) {
                    when (val outcome = TextInserter.insert(target, text, pressEnter, toClipboard = {})) {
                        is InsertOutcome.Inserted -> null
                        is InsertOutcome.Failed -> outcome.message
                    }
                }

            override fun focusedPackage(): String = "app.murmur.android"
        }
        return activity to field
    }

    @Test
    fun `the sample clip goes through the gateway and lands in the field, or is refused the way the contract says`() {
        val (activity, field) = setUp()
        val history = HistoryStore.get(activity)
        val recordings = RecordingStore.get(activity)

        DictationController.start(activity)
        assertTrue("pill should be listening", DictationController.state.value is DictationState.Listening)
        DictationController.stopAndInsert(activity)
        val outcome = awaitOutcome(timeoutMs = 90_000)
        println("gateway outcome: $outcome")

        when (expectation) {
            "dictation" -> {
                assertEquals(DictationState.Success("Inserted"), outcome)
                val text = field.text.toString()
                println("inserted: $text")
                assertTrue("the JFK clip mentions the country: $text", text.lowercase().contains("country"))
                val entry = history.entries.value.first()
                assertEquals(Inference.PROVIDER, entry.provider)
                assertEquals(Inference.STT_MODEL, entry.model)
                assertTrue("the gateway's model formatted it", entry.llmUsed)
                assertNull(entry.error)
                assertTrue("the recording is kept with the entry", recordings.has(entry.recording))
            }
            "refused" -> {
                assertTrue("expected a refusal, got $outcome", outcome is DictationState.Error)
                outcome as DictationState.Error
                val limit = outcome.limit
                assertNotNull("the pill carries the structured limit: ${outcome.message}", limit)
                println("refused on ${limit!!.limit}: ${limit.used} of ${limit.allowed}, resets ${limit.resetsAt}, upgrade ${limit.upgradeUrl}")
                assertTrue(limit.used >= limit.allowed)
                assertNotNull("the reset instant travels with the refusal", limit.resetsAt)
                assertTrue("a free account is offered the upgrade page", limit.plan != "free" || limit.upgradeUrl != null)
                assertEquals("", field.text.toString())
                val retryId = outcome.retryId
                assertNotNull("the recording survives the refusal", retryId)
                val entry = history.get(retryId!!)!!
                assertTrue(entry.retryable)
                assertTrue(recordings.has(entry.recording))

                // Retry sends the same audio again; the limit has not reset, so the same answer comes back.
                assertNull(DictationController.retry(activity, retryId, insert = true))
                val again = awaitOutcome(timeoutMs = 90_000)
                assertTrue("expected the refusal again, got $again", again is DictationState.Error)
                assertEquals(limit.limit, (again as DictationState.Error).limit?.limit)
                assertEquals(2, history.get(retryId)!!.attempts)
            }
            "unformatted" -> {
                assertTrue("expected a success, got $outcome", outcome is DictationState.Success)
                outcome as DictationState.Success
                assertEquals("Inserted", outcome.message)
                assertEquals("fairUseSttSecondsPerMonth", outcome.limit?.limit)
                assertEquals("pro", outcome.limit?.plan)
                val text = field.text.toString()
                println("inserted without formatting: $text")
                assertTrue(text.lowercase().contains("country"))
                val entry = history.entries.value.first()
                assertTrue("rule-based text, no model round trip", !entry.llmUsed)
            }
            else -> fail("unknown MURMUR_LIVE_EXPECT=$expectation")
        }
    }

    /** Pump the main looper (the insertion hops onto it) until the pill settles on a result. */
    private fun awaitOutcome(timeoutMs: Long): DictationState {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            when (val s = DictationController.state.value) {
                is DictationState.Success, is DictationState.Error -> return s
                else -> Thread.sleep(25)
            }
        }
        fail("dictation never finished; last state ${DictationController.state.value}")
        error("unreachable")
    }
}
