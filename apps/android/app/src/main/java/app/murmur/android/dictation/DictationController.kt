package app.murmur.android.dictation

import android.content.Context
import android.os.Build
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.audio.Recorder
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.cloud.CloudSync
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.service.RecordingService
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import app.murmur.android.text.AppContext
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.buildSttPrompt
import app.murmur.android.text.classifyPackage
import app.murmur.android.text.countWords
import app.murmur.android.text.finalizeAfterLlm
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.resolveTone
import app.murmur.android.text.runPipeline
import app.murmur.android.text.sanitizeLlmOutput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

private const val TAG = "MurmurDictation"

sealed class DictationState {
    data object Idle : DictationState()
    data class Listening(val elapsedSec: Int, val level: Float) : DictationState()
    data class Processing(val label: String) : DictationState()
    data class Success(val message: String) : DictationState()
    data class Error(val message: String) : DictationState()
}

/** Where the final text should go. */
interface TextSink {
    /** @return null on success, or a user-facing error message. */
    suspend fun insert(text: String, pressEnter: Boolean): String?

    /** Package name of the app owning the focused field, for tone/context rules. */
    fun focusedPackage(): String
}

/**
 * Orchestrates one dictation from pill tap to inserted text: record -> STT (with fallback
 * model retry) -> deterministic pipeline -> optional LLM formatting behind the sanitize
 * guard -> inject into the focused field. Mirrors the desktop session orchestrator.
 */
object DictationController {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val recorder = Recorder()

    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state

    var sink: TextSink? = null

    private var listeningJob: Job? = null
    private var resetJob: Job? = null
    @Volatile private var startedAt = 0L

    val isListening: Boolean get() = _state.value is DictationState.Listening
    val isBusy: Boolean get() = _state.value is DictationState.Processing

    fun toggle(context: Context) {
        when {
            isListening -> stopAndInsert(context)
            isBusy -> Unit
            else -> start(context)
        }
    }

    /**
     * The bundled sample clip only ever replaces the microphone in debug builds. A release install
     * on a phone must never end up dictating the same canned sentence because a debugging switch
     * was left on.
     */
    private fun fixtureMode(settings: MurmurSettings): Boolean = settings.useFixtureAudio && BuildConfig.DEBUG

    fun start(context: Context) {
        if (isListening || isBusy) return
        resetJob?.cancel()
        val appContext = context.applicationContext
        val settings = SettingsStore.get(appContext).get()
        startedAt = System.currentTimeMillis()

        if (fixtureMode(settings)) {
            // Debug aid for emulators without a microphone: "listen" briefly, then dictate
            // the bundled fixture clip through the real provider pipeline.
            _state.value = DictationState.Listening(0, 0.4f)
            listeningJob = scope.launch {
                while (isActive) {
                    val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                    _state.value = DictationState.Listening(elapsed, 0.3f + (Math.random() * 0.4f).toFloat())
                    delay(100)
                }
            }
            return
        }

        try {
            RecordingService.start(appContext)
            recorder.start(settings.maxDurationSec) { stopAndInsert(appContext) }
        } catch (e: Exception) {
            Log.e(TAG, "recorder start failed", e)
            RecordingService.stop(appContext)
            showTransient(DictationState.Error(friendlyError(e)))
            return
        }
        _state.value = DictationState.Listening(0, 0f)
        listeningJob = scope.launch {
            while (isActive) {
                val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                _state.value = DictationState.Listening(elapsed, recorder.level)
                delay(80)
            }
        }
    }

    fun cancel(context: Context) {
        if (!isListening) return
        listeningJob?.cancel()
        listeningJob = null
        recorder.cancel()
        RecordingService.stop(context.applicationContext)
        _state.value = DictationState.Idle
    }

    fun stopAndInsert(context: Context) {
        if (!isListening) return
        val appContext = context.applicationContext
        listeningJob?.cancel()
        listeningJob = null
        val settings = SettingsStore.get(appContext).get()
        _state.value = DictationState.Processing("Transcribing…")

        scope.launch {
            try {
                val wav: ByteArray = if (fixtureMode(settings)) {
                    loadFixture(appContext)
                } else {
                    val pcm = recorder.stop()
                    RecordingService.stop(appContext)
                    if (pcm.size < SAMPLE_RATE * 15 / 100) {
                        showTransient(DictationState.Error("Too short"))
                        return@launch
                    }
                    if (Wav.peakDb(pcm) < -48.0) {
                        showTransient(DictationState.Error("No speech detected"))
                        return@launch
                    }
                    Wav.encodePcm16(pcm, SAMPLE_RATE)
                }
                process(wav, settings)
            } catch (e: Exception) {
                Log.e(TAG, "dictation failed", e)
                RecordingService.stop(appContext)
                showTransient(DictationState.Error(friendlyError(e)))
            }
        }
    }

    private suspend fun process(wav: ByteArray, s: MurmurSettings) {
        // 1. STT
        val sttCfg = SttConfig(
            kind = s.sttKind,
            baseUrl = s.sttBaseUrl,
            apiKey = s.sttApiKey,
            model = s.sttModel,
            language = s.language,
            timeoutMs = s.sttTimeoutMs
        )
        val prompt = buildSttPrompt(s.dictionaryTerms)
        val stt = SttClient.transcribeWithFallback(wav, prompt, sttCfg, s.sttFallbackModel)
        val raw = stt.text.trim()
        Log.i(TAG, "stt done in ${stt.latencyMs}ms: ${raw.take(80)}")
        if (raw.isEmpty() ||
            (stt.noSpeechProb != null && stt.noSpeechProb > 0.85 && countWords(raw) <= 2)
        ) {
            showTransient(DictationState.Error("Nothing heard"))
            return
        }

        // 2. Deterministic pipeline
        val app: AppContext = classifyPackage(sink?.focusedPackage() ?: "")
        val pipelineOpts = PipelineOptions(
            removeFillers = s.removeFillers,
            collapseRepeats = s.collapseRepeats,
            spokenCommands = s.spokenCommands,
            selfCorrections = s.selfCorrections,
            autoCapitalize = s.autoCapitalize,
            trailingSpace = s.trailingSpace,
            pressEnterCommand = s.spokenCommands,
            dictionary = s.dictionaryEntries
        )
        val light = runPipeline(raw, pipelineOpts)
        var final = light
        val pressEnter = light.pressEnter

        // 3. Optional LLM formatting behind the guard
        val (llmBase, llmKey, llmModel) = s.llmConnection()
        val wantLlm = s.formattingMode == FormattingMode.SMART &&
            !light.empty && light.wordCount >= s.llmMinWords &&
            llmBase.isNotEmpty() && llmModel.isNotEmpty()
        if (wantLlm) {
            _state.value = DictationState.Processing("Formatting…")
            try {
                val res = LlmClient.chatComplete(
                    LlmConfig(llmBase, llmKey, llmModel, s.llmTimeoutMs),
                    buildFormatMessages(
                        light.text.trim(), s.dictionaryTerms, resolveTone(s.tone, app), app, s.language
                    ),
                    maxTokens = maxTokensFor(light.text)
                )
                val guard = sanitizeLlmOutput(res.text, light.text)
                if (guard.ok) {
                    final = finalizeAfterLlm(guard.text, pipelineOpts).copy(pressEnter = pressEnter)
                    Log.i(TAG, "llm formatting used (${res.latencyMs}ms)")
                } else {
                    Log.w(TAG, "llm output rejected (${guard.reason}); using deterministic text")
                }
            } catch (e: Exception) {
                Log.w(TAG, "llm formatting failed, using deterministic text: ${e.message}")
            }
        }
        if (s.formattingMode == FormattingMode.OFF) {
            final = light.copy(text = raw + if (s.trailingSpace) " " else "")
        }

        if (final.empty || final.text.isEmpty()) {
            showTransient(DictationState.Error("Nothing to insert"))
            return
        }

        // 4. Inject into the focused field
        val currentSink = sink
        if (currentSink == null) {
            showTransient(DictationState.Error("Accessibility service not running"))
            return
        }
        _state.value = DictationState.Processing("Inserting…")
        val error = currentSink.insert(final.text, final.pressEnter)
        if (error == null) {
            Log.i(TAG, "inserted ${final.wordCount} words")
            showTransient(DictationState.Success("Inserted"), 1500)
            CloudSync.get()?.recordSession(
                sessionId = UUID.randomUUID().toString(),
                words = final.wordCount,
                speechMs = System.currentTimeMillis() - startedAt
            )
        } else {
            showTransient(DictationState.Error(error))
        }
    }

    private fun showTransient(state: DictationState, holdMs: Long = 2500) {
        _state.value = state
        resetJob?.cancel()
        resetJob = scope.launch {
            delay(holdMs)
            _state.value = DictationState.Idle
        }
    }

    private fun loadFixture(context: Context): ByteArray {
        val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
        val (pcm, rate) = Wav.decodePcm16(bytes)
        val resampled = Wav.resample(pcm, rate, SAMPLE_RATE)
        return Wav.encodePcm16(resampled, SAMPLE_RATE)
    }

    fun friendlyError(err: Throwable): String = when {
        err is SttException -> err.friendly()
        err is SecurityException -> "Microphone permission missing — grant it in Murmur"
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            err is android.app.ForegroundServiceStartNotAllowedException ->
            "Android blocked background recording — open Murmur once and try again"
        else -> err.message ?: "Something went wrong"
    }
}
