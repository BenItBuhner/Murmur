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
import app.murmur.android.settings.DictionaryEntry
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
 * Dictations whose recording goes on after the speech with noise and no words (the phone handled,
 * a rustle, the tap that stops it), with the dictionary prompt on, through a real OpenAI-compatible
 * endpoint. Oct 29 2026: such a release tail came back as the prompt, and "Dictation with
 * punctuation." was typed after the dictation. Each clip is played into the microphone in real
 * time and stopped [MURMUR_LIVE_STOP_MS] after it ends. Opt-in:
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_STT_MODEL=... [MURMUR_LLM_MODEL=...] \
 *   MURMUR_LIVE_CLIPS=/path/a.wav,/path/b.wav [MURMUR_LIVE_STOP_MS=300] \
 *   ./gradlew :app:testDirectDebugUnitTest --tests '*LivePromptEchoTest*'
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LivePromptEchoTest {
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

    private fun idleUntil(timeoutMs: Long, done: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return true
            Thread.sleep(20)
        }
        return false
    }

    @After
    fun tearDown() {
        if (DictationController.isListening) DictationController.cancel(context)
        DictationController.dismiss()
        DictationController.sink = null
        ShadowAudioRecord.clearSource()
    }

    @Test
    fun `noise after the speech never comes back as the speech prompt`() {
        assumeTrue("Set MURMUR_LIVE=1 to run", env("MURMUR_LIVE") == "1")
        val clips = env("MURMUR_LIVE_CLIPS").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        assumeTrue("Set MURMUR_BASE_URL, MURMUR_STT_MODEL and MURMUR_LIVE_CLIPS", env("MURMUR_BASE_URL").isNotEmpty() && env("MURMUR_STT_MODEL").isNotEmpty() && clips.isNotEmpty())
        val stopAfterMs = env("MURMUR_LIVE_STOP_MS").toLongOrNull() ?: 300

        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val field = EditText(activity)
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
                useDictionaryPrompt = true,
                dictionaryEntries = listOf(DictionaryEntry("1", "Murmur"), DictionaryEntry("2", "Wispr Flow")),
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

            override fun focusedPackage(): String = "com.google.android.gm"
        }

        val failures = ArrayList<String>()
        for (path in clips) {
            val (raw, rate) = Wav.decodePcm16(File(path).readBytes())
            val pcm = Wav.resample(raw, rate, SAMPLE_RATE)
            field.setText("")
            playIntoMicrophone(pcm)
            DictationController.start(activity)
            assertTrue(idleUntil(pcm.size * 1000L / SAMPLE_RATE + 10_000) { clipEndedAt > 0 && System.currentTimeMillis() - clipEndedAt >= stopAfterMs })
            DictationController.stopAndInsert(activity)
            idleUntil(90_000) { DictationController.state.value.let { it is DictationState.Success || it is DictationState.Error } }
            val state = DictationController.state.value
            val entry = HistoryStore.get(activity).entries.value.firstOrNull()
            val name = File(path).name
            val text = field.text.toString()
            println("LIVE $name (${pcm.size / SAMPLE_RATE} s): $state")
            entry?.trace?.describe()?.lines()?.forEach { println("LIVE   $it") }
            println("LIVE   heard: ${entry?.rawText}")
            println("LIVE   inserted: $text")
            if (Regex("dictation with punctuation|vocabulary:", RegexOption.IGNORE_CASE).containsMatchIn(text)) failures.add("$name: the prompt was typed: $text")
            if (state != DictationState.Success("Inserted")) failures.add("$name: $state")
            DictationController.dismiss()
            Thread.sleep(2_000)
        }
        assertEquals(emptyList<String>(), failures)
    }
}
