package app.murmur.android.dictation

import android.content.Context
import android.os.Build
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.audio.Recorder
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.cloud.CloudSync
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.StageTimings
import app.murmur.android.llm.LlmClient
import app.murmur.android.llm.LlmConfig
import app.murmur.android.service.RecordingService
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttClient
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.lastVoicedSec
import app.murmur.android.stt.transcribeComplete
import app.murmur.android.text.AppContext
import app.murmur.android.text.PipelineOptions
import app.murmur.android.text.STT_BASE_PROMPT
import app.murmur.android.text.buildFormatMessages
import app.murmur.android.text.buildSttPrompt
import app.murmur.android.text.classifyPackage
import app.murmur.android.text.countWords
import app.murmur.android.text.finalizeAfterLlm
import app.murmur.android.text.maxTokensFor
import app.murmur.android.text.resolveStyle
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
    /** When the user stopped listening; speech duration is [stoppedAt] - [startedAt]. */
    @Volatile private var stoppedAt = 0L
    /** Id of the dictation in flight: the history entry and the account's idempotent stats record. */
    @Volatile private var sessionId = ""

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
        sessionId = UUID.randomUUID().toString()

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
        stoppedAt = System.currentTimeMillis()
        val settings = SettingsStore.get(appContext).get()
        _state.value = DictationState.Processing("Transcribing…")

        scope.launch {
            try {
                val pcm: ShortArray = if (fixtureMode(settings)) {
                    loadFixture(appContext)
                } else {
                    val recorded = recorder.stop()
                    RecordingService.stop(appContext)
                    if (recorded.size < SAMPLE_RATE * 15 / 100) {
                        showTransient(DictationState.Error("Too short"))
                        return@launch
                    }
                    if (Wav.peakDb(recorded) < -48.0) {
                        showTransient(DictationState.Error("No speech detected"))
                        return@launch
                    }
                    recorded
                }
                process(pcm, settings, appContext)
            } catch (e: Exception) {
                Log.e(TAG, "dictation failed", e)
                RecordingService.stop(appContext)
                val message = friendlyError(e)
                recordFailure(appContext, settings, raw = "", error = message)
                showTransient(DictationState.Error(message))
            }
        }
    }

    private suspend fun process(pcm: ShortArray, s: MurmurSettings, context: Context) {
        val recordMs = (stoppedAt - startedAt).coerceAtLeast(0)
        // 1. STT, and make sure the transcript reaches the end of the speech
        val sttStarted = System.currentTimeMillis()
        val sttCfg = SttConfig(
            kind = s.sttKind,
            baseUrl = s.sttBaseUrl,
            apiKey = s.sttApiKey,
            model = s.sttModel,
            language = s.language,
            timeoutMs = s.sttTimeoutMs
        )
        val prompt = buildSttPrompt(s.dictionaryTerms)
        val threshold = adaptiveThreshold(pcm, SAMPLE_RATE, -48.0)
        val complete = transcribeComplete(
            pcm = pcm,
            sampleRate = SAMPLE_RATE,
            speechEndSec = lastVoicedSec(pcm, SAMPLE_RATE, threshold),
            thresholdDb = threshold,
            prompt = prompt,
            // Resumed tails keep the style hint but never the vocabulary: a prompt that ends with a
            // term the speaker says next is exactly what makes Whisper stop early.
            tailPrompt = STT_BASE_PROMPT,
            log = { Log.w(TAG, it) }
        ) { wav, p -> SttClient.transcribeWithFallback(wav, p, sttCfg, s.sttFallbackModel) }
        val stt = complete.output
        if (complete.resumed > 0) {
            Log.i(TAG, "transcript recovered ${"%.1f".format(complete.recoveredSec)}s of speech in ${complete.resumed} extra request(s)")
        }
        val raw = stt.text.trim()
        val sttMs = System.currentTimeMillis() - sttStarted
        Log.i(TAG, "stt done in ${stt.latencyMs}ms: ${raw.take(80)}")
        if (raw.isEmpty() ||
            (stt.noSpeechProb != null && stt.noSpeechProb > 0.85 && countWords(raw) <= 2)
        ) {
            recordFailure(context, s, raw, "Nothing heard", StageTimings(recordMs = recordMs, sttMs = sttMs))
            showTransient(DictationState.Error("Nothing heard"))
            return
        }

        // 2. Deterministic pipeline (the destination decides lists/numbers: never lists in code or terminals)
        val focusedPackage = sink?.focusedPackage() ?: ""
        val app: AppContext = classifyPackage(focusedPackage)
        val style = resolveStyle(s, app)
        val formatStarted = System.currentTimeMillis()
        val pipelineOpts = PipelineOptions(
            removeFillers = s.removeFillers,
            hesitations = s.hesitations,
            hesitationPhrases = s.hesitationPhrases,
            collapseRepeats = s.collapseRepeats,
            repetitionScope = s.repetitionScope,
            spokenCommands = s.spokenCommands,
            selfCorrections = s.selfCorrections,
            autoCapitalize = s.autoCapitalize,
            trailingSpace = s.trailingSpace,
            pressEnterCommand = s.spokenCommands,
            lists = style.lists,
            listStyle = s.listStyle,
            bulletMarker = s.bulletMarker,
            numbers = style.numbers,
            dictionary = s.dictionaryEntries
        )
        val light = runPipeline(raw, pipelineOpts)
        val formatMs = System.currentTimeMillis() - formatStarted
        var final = light
        val pressEnter = light.pressEnter

        // 3. Optional LLM formatting behind the guard
        val (llmBase, llmKey, llmModel) = s.llmConnection()
        val wantLlm = s.formattingMode == FormattingMode.SMART &&
            !light.empty && light.wordCount >= s.llmMinWords &&
            llmBase.isNotEmpty() && llmModel.isNotEmpty()
        var llmMs = 0L
        var llm = LlmOutcome.SKIPPED
        var llmDetail: String? = when {
            s.formattingMode != FormattingMode.SMART -> "smart formatting off"
            light.wordCount < s.llmMinWords -> "too short"
            llmBase.isEmpty() || llmModel.isEmpty() -> "no model configured"
            else -> null
        }
        if (wantLlm) {
            _state.value = DictationState.Processing("Formatting…")
            val llmStarted = System.currentTimeMillis()
            try {
                val res = LlmClient.chatComplete(
                    LlmConfig(llmBase, llmKey, llmModel, s.llmTimeoutMs),
                    buildFormatMessages(
                        light.text.trim(), s.dictionaryTerms, style, app, light.hints, s.language,
                        dictionaryAliases = s.dictionaryEntries.associate { it.word.trim() to it.aliases }
                    ),
                    maxTokens = maxTokensFor(light.text)
                )
                val guard = sanitizeLlmOutput(res.text, light.text)
                if (guard.ok) {
                    final = finalizeAfterLlm(guard.text, pipelineOpts).copy(pressEnter = pressEnter)
                    llm = LlmOutcome.USED
                    llmDetail = null
                    Log.i(TAG, "llm formatting used (${res.latencyMs}ms)")
                } else {
                    llm = LlmOutcome.REJECTED
                    llmDetail = guard.reason
                    Log.w(TAG, "llm output rejected (${guard.reason}); using deterministic text")
                }
            } catch (e: Exception) {
                llm = LlmOutcome.FAILED
                llmDetail = e.message ?: "request failed"
                Log.w(TAG, "llm formatting failed, using deterministic text: ${e.message}")
            }
            llmMs = System.currentTimeMillis() - llmStarted
        }
        if (s.formattingMode == FormattingMode.OFF) {
            final = light.copy(text = raw + if (s.trailingSpace) " " else "")
        }

        val timings = StageTimings(recordMs = recordMs, sttMs = sttMs, formatMs = formatMs, llmMs = llmMs)
        if (final.empty || final.text.isEmpty()) {
            recordFailure(context, s, raw, "Nothing to insert", timings)
            showTransient(DictationState.Error("Nothing to insert"))
            return
        }

        // 4. Inject into the focused field
        val currentSink = sink
        if (currentSink == null) {
            recordFailure(context, s, raw, "Accessibility service not running", timings)
            showTransient(DictationState.Error("Accessibility service not running"))
            return
        }
        _state.value = DictationState.Processing("Inserting…")
        val injectStarted = System.currentTimeMillis()
        val error = currentSink.insert(final.text, final.pressEnter)
        val now = System.currentTimeMillis()
        val entry = HistoryEntry(
            id = sessionId,
            createdAt = now,
            rawText = raw,
            finalText = if (error == null) final.text.trimEnd() else "",
            wordCount = if (error == null) final.wordCount else 0,
            speechMs = recordMs,
            appName = appLabel(context, focusedPackage),
            provider = s.sttKind.id,
            model = modelName(s),
            injected = error == null,
            llmUsed = llm == LlmOutcome.USED,
            llm = llm,
            llmDetail = llmDetail,
            stages = final.stages,
            timings = timings.copy(injectMs = now - injectStarted, totalMs = now - stoppedAt),
            error = error
        )
        HistoryStore.get(context).add(entry)
        if (error == null) {
            Log.i(TAG, "inserted ${final.wordCount} words in ${entry.timings.totalMs}ms")
            showTransient(DictationState.Success("Inserted"), 1500)
            SettingsStore.get(context).update { current ->
                current.copy(stats = current.stats.record(entry.wordCount, entry.speechMs, DictationStats.localDay(now)))
            }
            CloudSync.get()?.recordSession(sessionId = entry.id, words = entry.wordCount, speechMs = entry.speechMs)
        } else {
            showTransient(DictationState.Error(error))
        }
    }

    /** A dictation that produced nothing still shows up in History, with what went wrong. */
    private fun recordFailure(
        context: Context,
        s: MurmurSettings,
        raw: String,
        error: String,
        timings: StageTimings = StageTimings(recordMs = (stoppedAt - startedAt).coerceAtLeast(0))
    ) {
        val now = System.currentTimeMillis()
        HistoryStore.get(context).add(
            HistoryEntry(
                id = sessionId.ifEmpty { UUID.randomUUID().toString() },
                createdAt = now,
                rawText = raw,
                finalText = "",
                wordCount = 0,
                speechMs = timings.recordMs,
                appName = appLabel(context, sink?.focusedPackage() ?: ""),
                provider = s.sttKind.id,
                model = modelName(s),
                injected = false,
                llmUsed = false,
                timings = timings.copy(totalMs = (now - stoppedAt).coerceAtLeast(0)),
                error = error
            )
        )
    }

    private fun modelName(s: MurmurSettings): String = s.sttModel.ifBlank {
        when (s.sttKind) {
            SttKind.DEEPGRAM -> "nova-3"
            SttKind.ELEVENLABS -> "scribe_v1"
            SttKind.OPENAI_COMPATIBLE -> ""
        }
    }

    /** The launcher label of the app that owned the field, when the system will tell us. */
    private fun appLabel(context: Context, packageName: String): String? {
        if (packageName.isBlank() || packageName == context.packageName) return null
        return try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        } catch (_: Exception) {
            packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }
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

    private fun loadFixture(context: Context): ShortArray {
        val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
        val (pcm, rate) = Wav.decodePcm16(bytes)
        return Wav.resample(pcm, rate, SAMPLE_RATE)
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
