package app.murmur.android

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.os.Looper
import android.widget.EditText
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.RecordingStore
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.TextInserter
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.SettingsStore
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.runPipeline
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

private const val TRANSCRIPT = "um so hello from murmur this is a test"

/**
 * The whole dictation, end to end, with only the microphone and the accessibility node lookup
 * swapped out: the bundled sample clip is sent over real HTTP to an in-process OpenAI-compatible
 * transcription endpoint, cleaned by the pipeline, and inserted into a real `EditText` through the
 * same accessibility actions the service sends. This is the path that used to end with an empty
 * field and a green "Inserted" pill.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DictationFlowTest {

    private val server = MockWebServer()
    private val requests = CopyOnWriteArrayList<String>()

    /** How many transcription requests the "server" still answers with a 500 before working. */
    @Volatile private var failures = 0

    @Before
    fun startMockStt() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add("${request.method} ${request.path} (${request.bodySize} bytes)")
                if (request.path != "/v1/audio/transcriptions") return MockResponse().setResponseCode(404)
                if (failures > 0) {
                    failures--
                    return MockResponse().setResponseCode(500).setBody("""{"error":{"message":"upstream exploded"}}""")
                }
                return MockResponse()
                    .setHeader("Content-Type", "application/json")
                    .setBody("""{"text":"$TRANSCRIPT","language":"en","segments":[{"no_speech_prob":0.01}]}""")
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        DictationController.sink = null
    }

    /** A focused field in a real activity, with the controller's sink pointed at it. */
    private fun setUpField(): Pair<Activity, EditText> {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())

        SettingsStore.get(activity).update {
            it.copy(
                sttBaseUrl = "http://${server.hostName}:${server.port}/v1",
                sttApiKey = "test-key",
                sttModel = "mock-whisper",
                sttFallbackModel = "",
                formattingMode = FormattingMode.LIGHT,
                useFixtureAudio = true,
                onboardingComplete = true
            )
        }

        val target = EditTextTarget(field)
        DictationController.sink = object : TextSink {
            override suspend fun insert(text: String, pressEnter: Boolean): String? =
                withContext(Dispatchers.Main.immediate) {
                    when (val outcome = TextInserter.insert(target, text, pressEnter) { }) {
                        is InsertOutcome.Inserted -> null
                        is InsertOutcome.Failed -> outcome.message
                    }
                }

            override fun focusedPackage(): String = "app.murmur.android"
        }
        return activity to field
    }

    @Test
    fun `sample dictation is transcribed, cleaned and lands in the focused field`() {
        val (activity, field) = setUpField()

        DictationController.start(activity)
        assertTrue("pill should be listening", DictationController.state.value is DictationState.Listening)
        DictationController.stopAndInsert(activity)

        val outcome = awaitOutcome(timeoutMs = 30_000)

        assertEquals(DictationState.Success("Inserted"), outcome)
        assertEquals("exactly one transcription request: $requests", 1, requests.size)
        assertTrue("STT received the audio: $requests", requests[0].startsWith("POST /v1/audio/transcriptions ("))
        val expected = runPipeline(TRANSCRIPT, PipelineOptions()).text
        assertEquals("So hello from murmur this is a test ", expected)
        assertEquals(expected, field.text.toString())
        assertEquals(expected.length, field.selectionStart)
    }

    @Test
    fun `a server error keeps the recording and the pill's Retry sends it again into the field`() {
        val (activity, field) = setUpField()
        val history = HistoryStore.get(activity)
        val recordings = RecordingStore.get(activity)
        failures = 1

        DictationController.start(activity)
        DictationController.stopAndInsert(activity)
        val failed = awaitOutcome(timeoutMs = 30_000)

        assertTrue("expected an error, got $failed", failed is DictationState.Error)
        val retryId = (failed as DictationState.Error).retryId
        assertNotNull("the pill offers a retry", retryId)
        val entry = history.get(retryId!!)!!
        assertTrue(entry.failed)
        assertTrue(entry.retryable)
        assertTrue("the audio is kept: ${entry.recording}", recordings.has(entry.recording))
        assertEquals("", field.text.toString())
        val createdAt = entry.createdAt

        // The same audio again, this time the server answers: the text lands where it was meant to.
        assertNull(DictationController.retry(activity, retryId, insert = true))
        val retried = awaitOutcome(timeoutMs = 30_000)

        assertEquals(DictationState.Success("Inserted"), retried)
        val expected = runPipeline(TRANSCRIPT, PipelineOptions()).text
        assertEquals(expected, field.text.toString())
        val done = history.get(retryId)!!
        assertEquals(expected.trimEnd(), done.finalText)
        assertNull(done.error)
        assertEquals(2, done.attempts)
        assertEquals(createdAt, done.createdAt)
        assertEquals("one entry, replaced in place", 1, history.entries.value.count { it.id == retryId })
        assertTrue("successful dictations keep their audio by default", recordings.has(done.recording))
        assertEquals("two transcription requests: $requests", 2, requests.size)

        // Nothing left to retry.
        assertNotNull(DictationController.retry(activity, retryId))
    }

    @Test
    fun `retry from History only copies the text and does not touch the field`() {
        val (activity, field) = setUpField()
        failures = 1

        DictationController.start(activity)
        DictationController.stopAndInsert(activity)
        val retryId = (awaitOutcome(timeoutMs = 30_000) as DictationState.Error).retryId!!

        assertNull(DictationController.retry(activity, retryId, insert = false))
        assertEquals(DictationState.Success("Copied"), awaitOutcome(timeoutMs = 30_000))
        assertEquals("", field.text.toString())
        val done = HistoryStore.get(activity).get(retryId)!!
        assertEquals(runPipeline(TRANSCRIPT, PipelineOptions()).text.trimEnd(), done.finalText)
        assertFalse(done.injected)
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals(runPipeline(TRANSCRIPT, PipelineOptions()).text, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
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
