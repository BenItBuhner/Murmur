package app.murmur.android

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.widget.EditText
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationMode
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.Haptic
import app.murmur.android.dictation.Haptics
import app.murmur.android.dictation.TextSink
import app.murmur.android.keyboard.HotkeyAction
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.TextInserter
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttSpeed
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
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

/**
 * What the hand feels through a whole dictation, with a recorder in place of the vibrator: the
 * press, the release and the inserted text each exactly once, the error pattern for a failure or
 * nothing heard, the same whether the floating button, the desktop-style pill or a hardware
 * shortcut started it, a Retry that fails again at once not felt twice, and nothing at all with
 * Haptics off. The sample clip goes over real HTTP to an in-process transcription endpoint, as in
 * [DictationFlowTest].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DictationHapticsTest {

    private val server = MockWebServer()
    private val felt = CopyOnWriteArrayList<Haptic>()

    /** The debounce's clock: a dictation's moments are seconds apart unless a test says otherwise. */
    @Volatile private var now = 100_000L

    /** How many transcription requests the "server" still answers with a 500 before working. */
    @Volatile private var failures = 0

    /** The "server" hears nothing in the clip. */
    @Volatile private var silence = false

    private lateinit var activity: Activity
    private lateinit var field: EditText

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path != "/v1/audio/transcriptions") return MockResponse().setResponseCode(404)
                if (failures > 0) {
                    failures--
                    return MockResponse().setResponseCode(500).setBody("""{"error":{"message":"upstream exploded"}}""")
                }
                val body = if (silence) """{"text":""}""" else """{"text":"hello from murmur this is a test","language":"en","segments":[{"no_speech_prob":0.01}]}"""
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()

        Haptics.reset()
        Haptics.clock = { now }
        Haptics.sink = Haptics.Sink { felt += it }

        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        field = EditText(activity)
        activity.setContentView(field)
        assertTrue(field.requestFocus())
        SettingsStore.get(activity).update {
            it.copy(
                sttBaseUrl = "http://${server.hostName}:${server.port}/v1",
                sttApiKey = "test-key",
                sttModel = "mock-whisper",
                sttFallbackModel = "",
                formattingMode = FormattingMode.LIGHT,
                llmSameAsStt = true,
                llmModel = "",
                useFixtureAudio = true,
                onboardingComplete = true,
                haptics = true,
                sounds = false,
                dictionaryEntries = emptyList(),
                snippets = emptyList(),
                appRules = emptyList(),
                sttSpeed = SttSpeed.NORMAL
            )
        }
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
        // The controller is process-wide: a message left on the pill by the last test is waved away.
        DictationController.dismiss()
    }

    @After
    fun tearDown() {
        server.shutdown()
        DictationController.sink = null
        Haptics.sink = null
        Haptics.clock = { SystemClock.uptimeMillis() }
        Haptics.reset()
    }

    @Test
    fun `from the floating button, the press, the release and the inserted text, once each`() {
        DictationController.toggle(activity)
        assertEquals(listOf(Haptic.START), felt)
        assertTrue(DictationController.state.value is DictationState.Listening)

        now += 3_000
        DictationController.toggle(activity)
        assertEquals(listOf(Haptic.START, Haptic.STOP), felt)

        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.DONE), felt)
        assertTrue(field.text.toString(), field.text.isNotBlank())
    }

    @Test
    fun `from a hardware shortcut, the same three, with the latch when the held key is tapped`() {
        DictationController.handle(activity, HotkeyAction.Start(DictationMode.HOLD))
        now += 200
        DictationController.handle(activity, HotkeyAction.Lock)
        assertEquals(listOf(Haptic.START, Haptic.LOCK), felt)
        val listening = DictationController.state.value as DictationState.Listening
        assertTrue(listening.locked)

        now += 3_000
        DictationController.handle(activity, HotkeyAction.Stop)
        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.LOCK, Haptic.STOP, Haptic.DONE), felt)
    }

    @Test
    fun `from the desktop-style pill's controls, confirm stops and cancel throws the session away`() {
        // The pill's confirm button is stopAndInsert, its cancel button is cancel: the service wires
        // them to the same controller calls as the floating button.
        DictationController.start(activity)
        now += 2_000
        DictationController.stopAndInsert(activity)
        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.DONE), felt)

        felt.clear()
        now += 5_000
        DictationController.start(activity)
        now += 2_000
        DictationController.cancel(activity)
        assertEquals(DictationState.Idle, DictationController.state.value)
        assertEquals(listOf(Haptic.START, Haptic.CANCEL), felt)
    }

    @Test
    fun `a failure is the error pattern, a Retry that fails again at once is not felt twice, and the Retry that works is done`() {
        failures = 2
        dictate()
        val failed = awaitOutcome()
        assertTrue("expected an error, got $failed", failed is DictationState.Error)
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.ERROR), felt)
        val retryId = (failed as DictationState.Error).retryId!!

        // Retry straight away, and the server is still down: the pill says so again, the hand is not buzzed again.
        now += 300
        assertNull(DictationController.retry(activity, retryId, insert = true))
        assertTrue(awaitOutcome() is DictationState.Error)
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.ERROR), felt)

        // A moment later the server is back: the text lands, felt as done.
        now += 2_000
        assertNull(DictationController.retry(activity, retryId, insert = true))
        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.ERROR, Haptic.DONE), felt)
    }

    @Test
    fun `a Retry from History copies the text, and that is done too`() {
        failures = 1
        dictate()
        val retryId = (awaitOutcome() as DictationState.Error).retryId!!
        now += 5_000
        assertNull(DictationController.retry(activity, retryId, insert = false))
        assertEquals(DictationState.Success("Copied"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.ERROR, Haptic.DONE), felt)
    }

    @Test
    fun `nothing heard is the error pattern`() {
        silence = true
        dictate()
        val outcome = awaitOutcome()
        assertEquals("Nothing heard", (outcome as DictationState.Error).message)
        assertEquals(listOf(Haptic.START, Haptic.STOP, Haptic.ERROR), felt)
    }

    @Test
    fun `a release on the heels of the press is not felt, the outcome is`() {
        DictationController.start(activity)
        now += 50
        DictationController.stopAndInsert(activity)
        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(listOf(Haptic.START, Haptic.DONE), felt)
    }

    @Test
    fun `with Haptics off a dictation is silent to the hand`() {
        SettingsStore.get(activity).update { it.copy(haptics = false) }
        failures = 1
        dictate()
        assertTrue(awaitOutcome() is DictationState.Error)
        now += 5_000
        dictate()
        assertEquals(DictationState.Success("Inserted"), awaitOutcome())
        assertEquals(emptyList<Haptic>(), felt)
    }

    private fun dictate() {
        DictationController.start(activity)
        now += 3_000
        DictationController.stopAndInsert(activity)
    }

    /** Pump the main looper (the insertion hops onto it) until the pill settles on a result. */
    private fun awaitOutcome(timeoutMs: Long = 30_000): DictationState {
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
