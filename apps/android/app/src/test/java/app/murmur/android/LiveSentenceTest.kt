package app.murmur.android

import android.Manifest
import android.app.Activity
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
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAudioRecord
import java.io.File

/**
 * Whole dictations against an OpenAI-compatible endpoint, to see what the pieces, the tail and the
 * formatter make of sentences cut by pauses. Each clip is played into the microphone in real time,
 * the real recorder, piece streamer, tail speculation, release and formatting run, and the stop
 * comes 0.6 s after the clip ends. Prints what was heard and what was inserted. Opt-in:
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_STT_MODEL=... MURMUR_LLM_MODEL=... \
 *   MURMUR_LIVE_CLIPS=/path/a.wav,/path/b.wav [MURMUR_LIVE_ROUNDS=2] [MURMUR_LIVE_PACKAGE=com.google.android.gm] \
 *   ./gradlew :app:testDirectDebugUnitTest --tests '*LiveSentenceTest*'
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LiveSentenceTest {
    private fun env(name: String): String = System.getenv(name) ?: ""
    private val context get() = RuntimeEnvironment.getApplication()

    @Volatile private var clipEndedAt = 0L

    private fun playIntoMicrophone(pcm: ShortArray) {
        clipEndedAt = 0L
        var started = 0L
        var delivered = 0L
        val source = object : ShadowAudioRecord.AudioRecordSource {
            override fun readInShortArray(audioData: ShortArray, offsetInShorts: Int, sizeInShorts: Int, isBlocking: Boolean): Int {
                if (started == 0L) started = System.nanoTime()
                fun available() = (System.nanoTime() - started) * SAMPLE_RATE / 1_000_000_000L - delivered
                if (isBlocking) while (available() < sizeInShorts) Thread.sleep(5)
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

    @Test
    fun `clips with pauses inside sentences come out as whole sentences`() {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        val clips = env("MURMUR_LIVE_CLIPS").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        assumeTrue(
            "Set MURMUR_BASE_URL, MURMUR_STT_MODEL, MURMUR_LLM_MODEL and MURMUR_LIVE_CLIPS",
            env("MURMUR_BASE_URL").isNotEmpty() && env("MURMUR_STT_MODEL").isNotEmpty() && env("MURMUR_LLM_MODEL").isNotEmpty() && clips.isNotEmpty()
        )
        val rounds = env("MURMUR_LIVE_ROUNDS").toIntOrNull() ?: 1
        val pkg = env("MURMUR_LIVE_PACKAGE").ifEmpty { "com.google.android.gm" }

        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val field = EditText(activity)
        activity.setContentView(field)
        assertTrue(field.requestFocus())
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
                formattingMode = FormattingMode.SMART,
                llmSameAsStt = true,
                llmModel = env("MURMUR_LLM_MODEL"),
                useFixtureAudio = false,
                onboardingComplete = true,
                useDictionaryPrompt = false,
                dictionaryEntries = emptyList(),
                snippets = emptyList(),
                appRules = emptyList(),
                stopPhraseEnabled = false
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

            override fun focusedPackage(): String = pkg
        }

        val failures = ArrayList<String>()
        repeat(rounds) { round ->
            for (path in clips) {
                val (raw, rate) = Wav.decodePcm16(File(path).readBytes())
                val pcm = Wav.resample(raw, rate, SAMPLE_RATE)
                field.setText("")
                playIntoMicrophone(pcm)
                DictationController.start(activity)
                assertTrue(DictationController.state.value is DictationState.Listening)
                assertTrue(idleUntil(pcm.size * 1000L / SAMPLE_RATE + 10_000) { clipEndedAt > 0 && System.currentTimeMillis() - clipEndedAt >= 600 })
                val stoppedAt = System.currentTimeMillis()
                DictationController.stopAndInsert(activity)
                val finished = idleUntil(90_000) { DictationController.state.value.let { it is DictationState.Success || it is DictationState.Error } }
                val state = DictationController.state.value
                val entry = HistoryStore.get(activity).entries.value.first()
                val name = File(path).name
                println("LIVE ${round + 1} $name (${pcm.size / SAMPLE_RATE} s): ${if (finished) state else "unfinished"}; stop to text ${System.currentTimeMillis() - stoppedAt} ms")
                println("LIVE   heard: ${entry.rawText}")
                println("LIVE   inserted: ${field.text}")
                if (state != DictationState.Success("Inserted")) failures.add("$name: $state")
                DictationController.dismiss()
                Thread.sleep(1_500)
            }
        }
        assertEquals("every clip inserted", emptyList<String>(), failures)
    }
}
