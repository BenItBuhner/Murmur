package app.murmur.android

import android.app.Activity
import android.os.Looper
import android.widget.EditText
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
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

    @Before
    fun startMockStt() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests.add("${request.method} ${request.path} (${request.bodySize} bytes)")
                if (request.path != "/v1/audio/transcriptions") return MockResponse().setResponseCode(404)
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

    @Test
    fun `sample dictation is transcribed, cleaned and lands in the focused field`() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())

        SettingsStore.get(activity).update {
            it.copy(
                sttBaseUrl = "http://${server.hostName}:${server.port}/v1",
                sttApiKey = "test-key",
                sttModel = "mock-whisper",
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
