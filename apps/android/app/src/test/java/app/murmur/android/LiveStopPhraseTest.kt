package app.murmur.android

import android.Manifest
import android.app.Activity
import android.media.AudioRecord
import android.os.Looper
import android.widget.EditText
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.history.HistoryStore
import app.murmur.android.service.InsertOutcome
import app.murmur.android.service.TextInserter
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.settings.SttSpeed
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioRecord

/**
 * The spoken stop phrase end to end against a real OpenAI-compatible endpoint: a recorded clip is
 * played into the microphone in real time (Robolectric's AudioRecord, paced to the clock, then
 * silence), the real recorder, listening loop, stop phrase watcher, speech model, formatting and
 * insertion run as on a phone, and nobody taps stop. Opt-in, like [LiveEndpointTest]:
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_STT_MODEL=... [MURMUR_LLM_MODEL=...] \
 *   ./gradlew :app:testDirectDebugUnitTest --tests '*LiveStopPhraseTest*'
 *
 * The clips (src/test/resources/stop-phrase) are espeak-ng speech (end.wav: `-v en-us+f3 -s 150`; the default
 * voice's "now" is heard as "out" by the speech model; mid.wav: `-v en-us -s 160`):
 *   end.wav  "Hey Sam, I just pushed the fix for the login bug. Can you take a look when you get a chance? Okay, send this now."
 *   mid.wav  "Okay, send this now, is what she told me. But the draft still needs another pass before it goes out."
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LiveStopPhraseTest {
    private fun env(name: String): String = System.getenv(name) ?: ""
    private val context get() = RuntimeEnvironment.getApplication()

    /** When the clip's last sample was handed to the recorder (wall clock), 0 until then. */
    @Volatile private var clipEndedAt = 0L

    private fun clip(name: String): ShortArray {
        val bytes = javaClass.getResourceAsStream("/stop-phrase/$name")!!.use { it.readBytes() }
        val (pcm, rate) = Wav.decodePcm16(bytes)
        return Wav.resample(pcm, rate, SAMPLE_RATE)
    }

    /** The microphone plays [pcm] at real-time speed, then silence. */
    private fun playIntoMicrophone(pcm: ShortArray) {
        clipEndedAt = 0L
        // Robolectric asks for a source on every read, so the position lives out here; the clock
        // starts with the first read, when the recorder is capturing.
        var started = 0L
        var delivered = 0L
        val source = object : ShadowAudioRecord.AudioRecordSource {
            override fun readInShortArray(audioData: ShortArray, offsetInShorts: Int, sizeInShorts: Int, isBlocking: Boolean): Int {
                if (started == 0L) started = System.nanoTime()
                fun available() = (System.nanoTime() - started) * SAMPLE_RATE / 1_000_000_000L - delivered
                if (isBlocking) {
                    while (available() < sizeInShorts) Thread.sleep(5)
                }
                val n = minOf(sizeInShorts.toLong(), maxOf(0L, available())).toInt()
                for (i in 0 until n) {
                    val at = delivered + i
                    audioData[offsetInShorts + i] = if (at < pcm.size) pcm[at.toInt()] else 0
                }
                delivered += n
                if (clipEndedAt == 0L && delivered >= pcm.size) clipEndedAt = System.currentTimeMillis()
                return n
            }
        }
        ShadowAudioRecord.setSourceProvider { _ -> source }
    }

    private lateinit var activity: Activity
    private lateinit var field: EditText

    @Before
    fun setUp() {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        assumeTrue("Set MURMUR_BASE_URL and MURMUR_STT_MODEL", env("MURMUR_BASE_URL").isNotEmpty() && env("MURMUR_STT_MODEL").isNotEmpty())
        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        field = EditText(activity).apply { hint = "Dictate into me…" }
        activity.setContentView(field)
        assertTrue(field.requestFocus())
        val llmModel = env("MURMUR_LLM_MODEL")
        SettingsStore.get(activity).update {
            it.copy(
                sttSource = InferenceSource.CUSTOM,
                llmSource = InferenceSource.CUSTOM,
                sttKind = SttKind.OPENAI_COMPATIBLE,
                sttBaseUrl = env("MURMUR_BASE_URL"),
                sttApiKey = env("MURMUR_API_KEY"),
                sttModel = env("MURMUR_STT_MODEL"),
                sttFallbackModel = "",
                sttSpeed = SttSpeed.NORMAL,
                formattingMode = if (llmModel.isNotEmpty()) FormattingMode.SMART else FormattingMode.LIGHT,
                llmSameAsStt = true,
                llmModel = llmModel,
                useFixtureAudio = false,
                onboardingComplete = true,
                useDictionaryPrompt = false,
                dictionaryEntries = emptyList(),
                snippets = emptyList(),
                appRules = emptyList(),
                stopPhraseEnabled = true,
                stopPhrase = "okay, send this now"
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
    }

    @After
    fun tearDown() {
        if (DictationController.isListening) DictationController.cancel(context)
        DictationController.dismiss()
        DictationController.sink = null
        ShadowAudioRecord.clearSource()
    }

    private fun idleUntil(timeoutMs: Long, done: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return true
            Thread.sleep(20)
        }
        return false
    }

    private fun outcome(): DictationState {
        assertTrue("dictation never finished; last state ${DictationController.state.value}", idleUntil(60_000) {
            DictationController.state.value.let { it is DictationState.Success || it is DictationState.Error }
        })
        return DictationController.state.value
    }

    @Test
    fun `saying the phrase at the end stops the dictation by itself and the phrase is not inserted`() {
        val pcm = clip("end.wav")
        playIntoMicrophone(pcm)
        DictationController.start(activity)
        assertTrue(DictationController.state.value is DictationState.Listening)

        // Nobody taps stop: the session has to end on its own once the phrase is said.
        val stoppedItself = idleUntil(pcm.size * 1000L / SAMPLE_RATE + 15_000) { !DictationController.isListening }
        val stoppedAt = System.currentTimeMillis()
        assertTrue("still listening ${(stoppedAt - clipEndedAt)} ms after the clip ended", stoppedItself)
        val afterSpeechMs = stoppedAt - clipEndedAt
        val result = outcome()
        val doneAt = System.currentTimeMillis()

        val entry = HistoryStore.get(activity).entries.value.first()
        println("LIVE stop phrase: clip ${pcm.size / SAMPLE_RATE.toDouble()} s; stopped ${afterSpeechMs} ms after the clip ended " +
            "(the clip ends 0.25 s after the last word); text in ${doneAt - clipEndedAt} ms after it")
        println("LIVE raw transcript (phrase cut): ${entry.rawText}")
        println("LIVE inserted: ${field.text}")
        assertEquals(DictationState.Success("Inserted"), result)
        val text = field.text.toString()
        assertTrue(text, text.contains("login bug", ignoreCase = true))
        assertTrue(text, text.contains("chance", ignoreCase = true))
        assertFalse("the phrase must not reach the field: $text", text.contains("send this", ignoreCase = true))
        assertFalse(text, text.contains("okay", ignoreCase = true))
        assertTrue("stopped within 4 s of the end of the speech: $afterSpeechMs ms", afterSpeechMs < 4_000)
    }

    @Test
    fun `the phrase said first and followed by more speech does not stop anything and stays in the text`() {
        val pcm = clip("mid.wav")
        playIntoMicrophone(pcm)
        DictationController.start(activity)

        val stoppedEarly = idleUntil(pcm.size * 1000L / SAMPLE_RATE + 4_000) { !DictationController.isListening }
        assertFalse("the session stopped on its own", stoppedEarly)
        DictationController.stopAndInsert(activity)
        val result = outcome()
        println("LIVE mid-sentence phrase, stopped by hand: ${field.text}")
        assertEquals(DictationState.Success("Inserted"), result)
        val text = field.text.toString()
        assertTrue(text, text.contains("send this", ignoreCase = true))
        assertTrue(text, text.contains("another pass", ignoreCase = true))
    }
}
