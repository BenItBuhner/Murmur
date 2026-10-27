package app.murmur.android.dictation

import android.content.ClipData
import android.content.ClipboardManager
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
import app.murmur.android.history.PartialStore
import app.murmur.android.history.PartialTranscript
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.RecordingStore
import app.murmur.android.history.StageTimings
import app.murmur.android.history.TraceRecorder
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouter
import app.murmur.android.inference.LimitNotice
import app.murmur.android.inference.ServiceNotice
import app.murmur.android.keyboard.HotkeyAction
import app.murmur.android.service.RecordingService
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.CompleteResult
import app.murmur.android.stt.Coverage
import app.murmur.android.stt.SttException
import app.murmur.android.stt.TranscribeOutput
import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.lastVoicedSec
import app.murmur.android.stt.transcribeComplete
import app.murmur.android.text.AppContext
import app.murmur.android.text.CommandPromptInput
import app.murmur.android.text.DictionaryTerm
import app.murmur.android.text.Engine
import app.murmur.android.text.FAST_SKIP_DETAIL
import app.murmur.android.text.Hallucination
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.FormatResult
import app.murmur.android.text.FormatStyle
import app.murmur.android.text.FormatStatus
import app.murmur.android.text.Prompt
import app.murmur.android.text.STT_BASE_PROMPT
import app.murmur.android.text.Verify
import app.murmur.android.text.buildSttPrompt
import app.murmur.android.text.classifyPackage
import app.murmur.android.text.countWords
import app.murmur.android.text.finish
import app.murmur.android.text.joinPieces
import app.murmur.android.text.joinSeam
import app.murmur.android.text.lastSentenceStart
import app.murmur.android.text.seamContext
import app.murmur.android.text.stripEcho
import app.murmur.android.text.resolveStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

private const val TAG = "MurmurDictation"

/** How long an error that can be retried stays on the pill, waiting for the user. */
private const val RETRY_HOLD_MS = 15_000L

/**
 * At release, the pieces and the tail speculation sent while recording get this long to finish
 * before the whole dictation is transcribed instead (Oct 15 2026: a stalled piece held the release
 * on "Transcribing…" for minutes).
 */
const val STREAM_WAIT_MS = 8_000L

/**
 * At release, the formatting done while the user spoke (the pieces' and the tail speculation's)
 * gets this long, all of it together, before the whole text is formatted instead. It was 8 s for
 * the speculation and then 8 s more for the pieces: a background model in its rate-limit cooldown
 * could hold a release for 16 s before the same text was formatted again (Oct 24 2026). Formatting
 * the whole text at release takes about a second.
 */
const val FORMAT_WAIT_MS = 3_000L

/**
 * The longest a release may take before the pill shows an error with Retry: 30 s plus 0.1 s per
 * second of audio, at most 4 minutes (a 30-minute dictation whose pieces all failed is transcribed
 * again in pieces, which takes a while). Desktop: releaseDeadlineMs.
 */
fun releaseDeadlineMs(audioSec: Double): Long = (30_000 + audioSec * 100).toLong().coerceAtMost(240_000)

/** A release that ran past [releaseDeadlineMs]. */
class ReleaseTimeoutException : Exception("Murmur took too long to transcribe this — tap Retry")

/** Command mode began with nothing selected; the same words as the desktop pill. */
const val NO_SELECTION = "Select some text first, then hold the command key"
const val NO_COMMAND_MODEL = "Command mode needs a formatting model (Style settings)"
/** A limit refusal is read, not glanced at; a text inserted unformatted deserves a beat more too. */
private const val LIMIT_HOLD_MS = 20_000L
private const val SOFT_LIMIT_HOLD_MS = 5_000L

sealed class DictationState {
    data object Idle : DictationState()

    /**
     * [mode] and [locked] are what the desktop pill shows: a hands-free badge on a locked session,
     * the command tint while an instruction is being spoken. A session from the button is hands-free.
     */
    data class Listening(
        val elapsedSec: Int,
        val level: Float,
        val mode: DictationMode = DictationMode.HANDS_FREE,
        val locked: Boolean = mode == DictationMode.HANDS_FREE
    ) : DictationState()

    data class Processing(val label: String, val mode: DictationMode = DictationMode.HANDS_FREE) : DictationState()

    /**
     * [limit]: the text went in with rule-based cleanup only because the Murmur instance paused or
     * refused the formatting model on a plan limit; the pill says so in passing.
     */
    data class Success(val message: String, val limit: LimitNotice? = null) : DictationState()

    /**
     * [retryId]: the history entry whose stored recording can be sent again. The pill then shows a
     * Retry button and stays up until the user acts on it (or gives up on them after a while).
     * [limit]: the plan limit that refused the request; the pill explains it and offers Upgrade and
     * the user's own provider as the ways forward, beside Retry.
     * [service]: the Murmur instance answered that the provider behind its models is down
     * (`provider_unavailable`); not a fault of the user's, so the pill explains it calmly, in its
     * own colour, with Retry beside it.
     */
    data class Error(
        val message: String,
        val retryId: String? = null,
        val limit: LimitNotice? = null,
        val service: ServiceNotice? = null
    ) : DictationState()
}

/** One run of the pipeline: a dictation that was just spoken, or a stored one sent again. */
private class Run(
    val id: String,
    /** Speech captured, for the entry and the stats. */
    val recordMs: Long,
    /** File name of the stored audio, when it was kept. */
    val recording: String?,
    /** Sent again: the failed entry this run replaces. */
    val previous: HistoryEntry? = null,
    /** How many times this audio has now been sent for transcription. */
    val attempts: Int = 1,
    /**
     * Insert the text into the focused field. A retry started from the History screen only copies
     * it: the focused field, if any, is Murmur's own search box.
     */
    val insert: Boolean = true,
    val mode: DictationMode = DictationMode.HANDS_FREE,
    /** Command mode: the text that was selected when the session began, which the edit replaces. */
    val selection: Selection? = null
) {
    /** Where this run's time goes; kept with its History entry, failed or not. */
    val trace = TraceRecorder(if (previous != null) "retry" else "whole")
}

/** The selected text in the focused field and where it sits, as the accessibility node reports it. */
data class Selection(val text: String, val start: Int, val end: Int)

/** Where the final text should go. */
interface TextSink {
    /** @return null on success, or a user-facing error message. */
    suspend fun insert(text: String, pressEnter: Boolean): String?

    /** Package name of the app owning the focused field, for tone/context rules. */
    fun focusedPackage(): String

    /**
     * The text before the cursor in the focused field, when the platform can read it. The model
     * continues it naturally (mid-sentence means no capital, an ongoing list keeps its markers).
     */
    suspend fun precedingText(): String? = null

    /** The selected text in the focused field, for command mode; null when there is none. */
    suspend fun readSelection(): Selection? = null

    /**
     * Put [text] in place of [selection] (command mode). The default writes it where the cursor is.
     * @return null on success, or a user-facing error message.
     */
    suspend fun replaceSelection(selection: Selection, text: String): String? = insert(text, pressEnter = false)
}

/**
 * Orchestrates one dictation from pill tap to inserted text: record -> STT (with fallback
 * model retry) -> the text engine (the formatting model on the raw transcript, verified, with the
 * rule-based cleanup as the fallback) -> inject into the focused field. Mirrors the desktop
 * session orchestrator.
 */
object DictationController {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val recorder = Recorder()

    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state

    /** Set by the accessibility service (its thread) and read by the pipeline's coroutines. */
    @Volatile var sink: TextSink? = null

    private var listeningJob: Job? = null
    /** Long dictations to Murmur go up in pieces while they are spoken. */
    @Volatile private var streamer: ChunkStreamer? = null
    /** Listens for the spoken stop phrase while recording, when the user turned it on. */
    @Volatile private var stopWatcher: StopPhraseWatcher? = null
    /** The session in flight was ended by its stop phrase (not a tap). */
    @Volatile private var phraseStopped = false
    /** Where the stop phrase ended in the recording (sample index), when it ended the session. */
    @Volatile private var phraseEndSample = -1
    /** Precision mode: each streamed piece formatted on the gateway while the user keeps talking. */
    private var pieceFormats: MutableList<Deferred<PieceFormat>> = java.util.Collections.synchronizedList(ArrayList())
    /** The newest tail speculation's text job and its formatting, while recording. */
    @Volatile private var tailSpecFormat: Pair<Deferred<String>, Deferred<PieceFormat>>? = null

    private sealed interface PieceFormat {
        data object Empty : PieceFormat
        data object Unavailable : PieceFormat
        data class Done(val result: FormatResult) : PieceFormat
    }
    /** Cancelled from the UI thread, replaced from the pipeline: a stale read lets an old job blank the pill early. */
    @Volatile private var resetJob: Job? = null
    @Volatile private var startedAt = 0L
    /** When the user stopped listening; speech duration is [stoppedAt] - [startedAt]. */
    @Volatile private var stoppedAt = 0L
    /** Id of the dictation in flight: the history entry and the account's idempotent stats record. */
    @Volatile private var sessionId = ""
    /** How the session in flight was started, and whether it runs until stopped. */
    @Volatile private var mode = DictationMode.HANDS_FREE
    @Volatile private var locked = true
    /** Command mode: the selection read when the session began; null until it has been, or when there was none. */
    @Volatile private var selectionJob: kotlinx.coroutines.Deferred<Selection?>? = null

    val isListening: Boolean get() = _state.value is DictationState.Listening
    val isBusy: Boolean get() = _state.value is DictationState.Processing

    /** The floating button and the idle bar: toggles a hands-free session. */
    fun toggle(context: Context) {
        when {
            isListening -> stopAndInsert(context)
            isBusy -> Unit
            else -> start(context)
        }
    }

    /** A hardware shortcut fired (see [app.murmur.android.keyboard.HotkeyEngine]). */
    fun handle(context: Context, action: HotkeyAction) {
        when (action) {
            is HotkeyAction.Start -> start(context, action.mode)
            HotkeyAction.Lock -> lock(context)
            HotkeyAction.Stop -> stopAndInsert(context)
            HotkeyAction.Cancel -> cancel(context)
        }
    }

    /** A tap of the held shortcut, or the hands-free shortcut on top of it: keep recording until stopped. */
    fun lock(context: Context) {
        if (!isListening) return
        locked = true
        if (mode == DictationMode.HOLD) mode = DictationMode.HANDS_FREE
        (_state.value as? DictationState.Listening)?.let { _state.value = it.copy(mode = mode, locked = true) }
        Haptics.play(context, Haptic.LOCK)
        Cues.play(context, Cue.LOCK)
    }

    /**
     * The bundled sample clip only ever replaces the microphone in debug builds. A release install
     * on a phone must never end up dictating the same canned sentence because a debugging switch
     * was left on.
     */
    private fun fixtureMode(settings: MurmurSettings): Boolean = settings.useFixtureAudio && BuildConfig.DEBUG

    /**
     * Begin listening. [mode] HOLD records until the key is released (a tap locks it), HANDS_FREE
     * until stopped, COMMAND takes an instruction for the selected text: the selection is read as
     * the session begins (there is no waiting for a key release here, so nothing is lost by reading
     * it first), and a session with nothing selected ends at once with a notice.
     *
     * [selectionDelayMs] is the one entry-point exception (DictationEntryActivity, command mode):
     * the selection must be read in the user's app, and the trampoline that took the intent is in
     * front until it finishes, so the read waits that long — the session itself (and the
     * microphone service) starts at once, while the trampoline is resumed. Zero everywhere else.
     */
    fun start(context: Context, mode: DictationMode = DictationMode.HANDS_FREE, selectionDelayMs: Long = 0L) {
        if (isListening || isBusy) return
        resetJob?.cancel()
        val appContext = context.applicationContext
        val settings = SettingsStore.get(appContext).get()
        startedAt = System.currentTimeMillis()
        sessionId = UUID.randomUUID().toString()
        this.mode = mode
        locked = mode == DictationMode.HANDS_FREE
        selectionJob = null
        phraseStopped = false
        phraseEndSample = -1

        if (mode == DictationMode.COMMAND) {
            val currentSink = sink
            if (currentSink == null) {
                showNotice(appContext, "Accessibility service not running")
                return
            }
            selectionJob = scope.async {
                if (selectionDelayMs > 0) delay(selectionDelayMs)
                runCatching { currentSink.readSelection() }.getOrNull()
            }
        }

        // The press is felt the moment it is accepted, ahead of the recorder's own start-up: a
        // click that lags the finger reads as a button that did not take.
        Haptics.play(appContext, Haptic.START)

        if (fixtureMode(settings)) {
            // Debug aid for emulators without a microphone: "listen" briefly, then dictate
            // the bundled fixture clip through the real provider pipeline.
            _state.value = DictationState.Listening(0, 0.4f, mode, locked)
            listeningJob = scope.launch {
                while (isActive) {
                    val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                    _state.value = DictationState.Listening(elapsed, 0.3f + (Math.random() * 0.4f).toFloat(), this@DictationController.mode, locked)
                    delay(100)
                }
            }
        } else {
            try {
                RecordingService.start(appContext)
                recorder.start(settings.sessionDurationLimitSec) { stopAndInsert(appContext) }
            } catch (e: Exception) {
                Log.e(TAG, "recorder start failed", e)
                RecordingService.stop(appContext)
                showNotice(appContext, friendlyError(e))
                return
            }
            _state.value = DictationState.Listening(0, 0f, mode, locked)
            streamer = if (mode != DictationMode.COMMAND && murmurSpeech(appContext)) newStreamer(appContext, settings) else null
            stopWatcher = if (settings.stopPhraseEnabled) newStopWatcher(appContext, settings) else null
            // Open the connections to the gateway now, so the release does not pay for them.
            if (murmurSpeech(appContext)) scope.launch { runCatching { InferenceRouter.get(appContext).prewarm() } }
            listeningJob = scope.launch {
                while (isActive) {
                    val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                    _state.value = DictationState.Listening(elapsed, recorder.level, this@DictationController.mode, locked)
                    streamer?.let { st -> runCatching { st.poll(recorder.sampleCount()) } }
                    stopWatcher?.let { w -> runCatching { w.poll(recorder.sampleCount()) } }
                    delay(80)
                }
            }
        }

        // The desktop marks a command session with the lock cue; a dictation with the start cue.
        Cues.play(appContext, if (mode == DictationMode.COMMAND) Cue.LOCK else Cue.START)

        val selection = selectionJob
        if (mode == DictationMode.COMMAND && selection != null) {
            // Nothing selected: say so now rather than after the user has spoken the instruction.
            val id = sessionId
            scope.launch {
                if (selection.await() == null && isListening && sessionId == id) {
                    cancel(appContext)
                    showNotice(appContext, NO_SELECTION)
                }
            }
        }
    }

    fun cancel(context: Context) {
        if (!isListening) return
        listeningJob?.cancel()
        listeningJob = null
        streamer = null
        stopWatcher?.close()
        stopWatcher = null
        partialsOf(context).clear(sessionId)
        recorder.cancel()
        RecordingService.stop(context.applicationContext)
        _state.value = DictationState.Idle
        Haptics.play(context, Haptic.CANCEL)
        Cues.play(context, Cue.CANCEL)
    }

    fun stopAndInsert(context: Context) {
        if (!isListening) return
        val appContext = context.applicationContext
        listeningJob?.cancel()
        listeningJob = null
        stopWatcher?.close()
        stopWatcher = null
        stoppedAt = System.currentTimeMillis()
        val settings = SettingsStore.get(appContext).get()
        val mode = this.mode
        val selectionJob = this.selectionJob
        val phraseHeard = phraseStopped
        val phraseEnd = phraseEndSample
        _state.value = DictationState.Processing("Transcribing…", mode)
        Haptics.play(appContext, Haptic.STOP)
        Cues.play(appContext, Cue.STOP)

        scope.launch {
            val id = sessionId
            var run: Run? = null
            var streamed: Streamed? = null
            // The recording service (and its wake lock) stops before the release is processed; a
            // long dictation's release must not stall because the screen went off.
            val processingLock = RecordingService.acquireWakeLock(appContext, "murmur:processing", RecordingService.PROCESSING_WAKE_LOCK_MS)
            try {
                val pcm: ShortArray = if (fixtureMode(settings)) {
                    loadFixture(appContext)
                } else {
                    // Ended on the stop phrase: the silence the watcher waited through (and the
                    // post-roll) is dropped, so the speech model is not handed a second of quiet
                    // to invent a "Thank you." in.
                    val recorded = recorder.stop().let { all ->
                        if (phraseHeard && phraseEnd > 0) all.copyOf(minOf(all.size, phraseEnd + PHRASE_TAIL_SAMPLES)) else all
                    }
                    streamed = streamer?.takeIf { it.hasWork }?.finish()
                    streamer = null
                    RecordingService.stop(appContext)
                    if (recorded.size < SAMPLE_RATE * 15 / 100) {
                        showNotice(appContext, "Too short")
                        return@launch
                    }
                    if (Wav.peakDb(recorded) < -48.0) {
                        showNotice(appContext, "No speech detected")
                        return@launch
                    }
                    recorded
                }
                // Store the audio before anything can go wrong with it: a failed request is retried
                // from this file, and a kept recording is what History plays back.
                val started = Run(
                    id,
                    recordMs = (stoppedAt - startedAt).coerceAtLeast(0),
                    recording = storeRecording(appContext, id, pcm),
                    mode = mode,
                    selection = selectionJob?.await()
                )
                run = started
                // A hard deadline: whatever stalls, the pill never sits on "Transcribing…" forever.
                // The work runs on its own so a blocking request cannot hold the deadline up.
                val work = scope.async { process(started, pcm, settings, appContext, InferenceRouter.get(appContext), streamed, phraseHeard) }
                val finished = withTimeoutOrNull(releaseDeadlineMs(pcm.size.toDouble() / SAMPLE_RATE)) { work.await(); true }
                if (finished == null) {
                    work.cancel()
                    Log.w(TAG, "release passed its deadline; offering Retry")
                    throw ReleaseTimeoutException()
                }
            } catch (e: Exception) {
                Log.e(TAG, "dictation failed", e)
                RecordingService.stop(appContext)
                val message = friendlyError(e)
                val failed = run ?: Run(id, recordMs = (stoppedAt - startedAt).coerceAtLeast(0), recording = null, mode = mode)
                recordFailure(appContext, settings, failed, raw = "", error = message)
                showError(appContext, message, failed, planLimitOf(e), serviceNoticeOf(e))
            } finally {
                processingLock?.let { if (it.isHeld) it.release() }
                partialsOf(appContext).clear(id)
                run?.let { releaseRecording(appContext, it) }
            }
        }
    }

    /**
     * Send a dictation's stored audio through the pipeline again. With [insert] the result goes into
     * the field that is still focused (the pill's Retry button, moments after the failure); without
     * it the text is copied to the clipboard and kept in History (the History screen's Retry).
     *
     * @return null when the retry is under way, or why it could not start.
     */
    fun retry(context: Context, id: String, insert: Boolean = true): String? {
        if (isListening) return "Finish the current dictation first"
        if (isBusy) return "Still working on the last one"
        val appContext = context.applicationContext
        val entry = HistoryStore.get(appContext).get(id) ?: return "This dictation is no longer in History"
        if (entry.finalText.isNotEmpty()) return "This dictation already has its text"
        if (entry.mode == DictationMode.COMMAND) return "A command needs its selection: select the text and say it again"
        val recording = entry.recording?.takeIf { RecordingStore.get(appContext).has(it) }
            ?: return "The recording of this dictation was not kept"
        val decoded = RecordingStore.get(appContext).read(recording) ?: return "The recording could not be read"
        val settings = SettingsStore.get(appContext).get()
        resetJob?.cancel()
        sessionId = id
        stoppedAt = System.currentTimeMillis()
        startedAt = stoppedAt - entry.speechMs
        _state.value = DictationState.Processing("Transcribing…")
        val run = Run(
            id = id,
            recordMs = entry.speechMs,
            recording = recording,
            previous = entry,
            attempts = entry.attempts + 1,
            insert = insert,
            mode = entry.mode
        )
        Log.i(TAG, "retry #${run.attempts} of ${id.take(8)}${if (insert) "" else " (copy only)"}")
        scope.launch {
            try {
                val (pcm, rate) = decoded
                process(run, Wav.resample(pcm, rate, SAMPLE_RATE), settings, appContext, InferenceRouter.get(appContext))
            } catch (e: Exception) {
                Log.e(TAG, "retry failed", e)
                val message = friendlyError(e)
                recordFailure(appContext, settings, run, raw = "", error = message)
                showError(appContext, message, run, planLimitOf(e), serviceNoticeOf(e))
            } finally {
                releaseRecording(appContext, run)
            }
        }
        return null
    }

    /** The user waved the pill's message away. */
    fun dismiss() {
        if (_state.value is DictationState.Error || _state.value is DictationState.Success) {
            resetJob?.cancel()
            _state.value = DictationState.Idle
        }
    }

    private fun storeRecording(context: Context, id: String, pcm: ShortArray): String? = try {
        RecordingStore.get(context).save(id, pcm, SAMPLE_RATE)
    } catch (e: Exception) {
        Log.w(TAG, "could not store the recording", e)
        null
    }

    private fun partialsOf(context: Context) = PartialStore(java.io.File(context.applicationContext.filesDir, "partials"))

    /** After a run: audio that no History entry refers to any more has nothing to be kept for. */
    private fun releaseRecording(context: Context, run: Run) {
        val name = run.recording ?: return
        if (HistoryStore.get(context).get(run.id)?.recording != name) RecordingStore.get(context).delete(name)
    }

    /**
     * Transcribe finished 15-30 s stretches while the user keeps talking, so release only waits
     * for the last one. A piece that fails makes the dictation go up whole, as before.
     */
    private fun newStreamer(context: Context, s: MurmurSettings): ChunkStreamer {
        val router = InferenceRouter.get(context)
        val styleAt = scope.async(start = CoroutineStart.LAZY) {
            val pkg = sink?.focusedPackage() ?: ""
            val app = classifyPackage(pkg, appLabel(context, pkg))
            Triple(pkg, app, resolveStyle(s, app))
        }
        val target = scope.async(start = CoroutineStart.LAZY) { router.stt(speed = styleAt.await().third.speed) }
        val formats = java.util.Collections.synchronizedList(ArrayList<Deferred<PieceFormat>>())
        pieceFormats = formats
        val textJobs = java.util.Collections.synchronizedList(ArrayList<Deferred<String>>())
        tailSpecFormat = null
        fun formatPiece(textJob: Deferred<String>, before: Deferred<String>?): Deferred<PieceFormat> = scope.async {
            try {
                val text = textJob.await()
                if (text.isEmpty()) return@async PieceFormat.Empty
                val (pkg, app, style) = styleAt.await()
                if (style.effectiveMode != FormattingMode.SMART || !murmurFormatting(context)) return@async PieceFormat.Unavailable
                val started = System.currentTimeMillis()
                // The piece continues the one before it (seen as the text before the cursor), and
                // may itself stop mid-sentence.
                val prior = seamContext(before?.let { runCatching { it.await() }.getOrNull() }.orEmpty())
                val base = formatInputFor(text, FormattingMode.SMART, style, app, pkg, s, context, precedingText = prior.ifEmpty { null })
                val out = router.formatter().formatBackground(base.copy(context = base.context.copy(instructions = listOfNotNull(base.context.instructions, PIECE_NOTE).joinToString(" "))))
                Log.i(TAG, "piece formatted in ${System.currentTimeMillis() - started} ms while recording")
                if (out.status.outcome == FormatOutcome.FAILED) PieceFormat.Unavailable
                else PieceFormat.Done(out.copy(text = stripEcho(out.text, prior)))
            } catch (e: Exception) {
                PieceFormat.Unavailable
            }
        }
        // Crash recovery: each piece's text goes to disk as it comes back (cleared when the dictation ends).
        val partials = partialsOf(context)
        val partialId = sessionId
        val partialMode = mode.id
        val partialAt = startedAt
        val partialTexts = java.util.concurrent.ConcurrentHashMap<Int, String>()
        val onPiece: (Int, Deferred<String>) -> Unit = { index, textJob ->
            scope.launch {
                val text = runCatching { textJob.await() }.getOrNull() ?: return@launch
                partialTexts[index] = text
                val n = (partialTexts.keys.maxOrNull() ?: -1) + 1
                partials.save(PartialTranscript(partialId, partialAt, partialMode, (0 until n).map { partialTexts[it] }))
            }
            textJobs.add(textJob)
            formats.add(formatPiece(textJob, if (index > 0) textJobs[index - 1] else null))
        }
        // The stretch after the last piece, up to its latest pause: release then only waits for
        // the words after that pause.
        val onSpec: (Int, Deferred<String>) -> Unit = { index, textJob ->
            tailSpecFormat = textJob to formatPiece(textJob, if (index > 0) textJobs[index - 1] else null)
        }
        val prompt = if (s.useDictionaryPrompt) buildSttPrompt(s.dictionaryTerms + s.snippetTriggers) else null
        return ChunkStreamer(scope, { from -> recorder.read(from) }, SAMPLE_RATE, -48.0, onPiece = onPiece, onSpec = onSpec) { pcm, index ->
            val resolved = target.await()
            if (Wav.peakDb(pcm) < -48.0) return@ChunkStreamer ""
            val threshold = adaptiveThreshold(pcm, SAMPLE_RATE, -48.0)
            val started = System.currentTimeMillis()
            val out = transcribeComplete(
                pcm = pcm,
                sampleRate = SAMPLE_RATE,
                speechEndSec = lastVoicedSec(pcm, SAMPLE_RATE, threshold),
                thresholdDb = threshold,
                prompt = prompt,
                tailPrompt = if (prompt != null) STT_BASE_PROMPT else null,
                log = { Log.w(TAG, "piece $index: $it") }
            ) { wav, p -> router.transcribe(resolved, wav, p, Inference.TIER_BACKGROUND) }
            Log.i(TAG, "piece $index (${pcm.size / SAMPLE_RATE} s) transcribed in ${System.currentTimeMillis() - started} ms while recording")
            out.output.text.trim()
        }
    }

    /**
     * The stop phrase listener: on each pause the last few seconds go to the speech model on the
     * background tier, and a match ends the session as a second tap would.
     */
    private fun newStopWatcher(context: Context, s: MurmurSettings): StopPhraseWatcher? {
        if (StopPhrase.normalized(s.stopPhrase).isEmpty()) return null
        val router = InferenceRouter.get(context)
        val target = scope.async(start = CoroutineStart.LAZY) { router.stt() }
        val id = sessionId
        return StopPhraseWatcher(
            scope,
            read = { from -> recorder.read(from) },
            sampleRate = SAMPLE_RATE,
            phrase = s.stopPhrase,
            log = { Log.i(TAG, it) },
            transcribe = { pcm -> router.transcribe(target.await(), Wav.encodePcm16(pcm, SAMPLE_RATE), null, Inference.TIER_BACKGROUND).text }
        ) { _, speechEnd ->
            if (sessionId != id || !isListening) return@StopPhraseWatcher
            Log.i(TAG, "stop phrase heard; ending the dictation")
            phraseStopped = true
            phraseEndSample = speechEnd
            stopAndInsert(context)
        }
    }

    private fun murmurFormatting(context: Context): Boolean =
        InferenceRouter.get(context).routing().llm == InferenceSource.MURMUR

    private fun formatInputFor(
        transcript: String,
        mode: FormattingMode,
        style: FormatStyle,
        app: AppContext,
        focusedPackage: String,
        s: MurmurSettings,
        context: Context,
        precedingText: String?
    ) = FormatInput(
        transcript = transcript,
        mode = mode,
        context = FormatContext(
            category = app.category,
            tone = style.tone,
            app = focusedPackage.takeIf { it.isNotBlank() && it != context.packageName },
            language = s.language,
            precedingText = precedingText,
            instructions = style.instructions.takeIf { it.isNotEmpty() },
            dictionary = s.dictionaryEntries.map { DictionaryTerm(it.word, it.aliases, it.fuzzy) },
            // Snippet triggers are expanded after the model; it must leave them alone.
            keepVerbatim = s.snippetTriggers
        ),
        dictionary = s.dictionaryEntries
    )

    /**
     * A streamed precision dictation whose pieces were all formatted while it was spoken: only the
     * tail is formatted now and the parts are joined. Null to format the whole text as before.
     */
    private suspend fun formatWithSpeculation(
        router: InferenceRouter,
        input: FormatInput,
        texts: List<String>?,
        tail: String?,
        spec: Deferred<String>? = null,
        preformatted: Pair<String, FormatResult>? = null,
        trace: TraceRecorder? = null
    ): FormatResult? {
        val specs = pieceFormats.toList()
        pieceFormats = java.util.Collections.synchronizedList(ArrayList())
        val specFormat = tailSpecFormat
        tailSpecFormat = null
        if (texts == null || tail == null || specs.size != texts.size) return null
        val formatter = router.formatter()
        if (formatter.source != InferenceSource.MURMUR) return null
        // A formatted tail speculation: its last sentence is formatted again with the words that
        // followed, so the model sees that sentence whole; the rest of it stands.
        var specHead: FormatResult? = null
        var tailText = tail
        var tailBefore = texts.lastOrNull().orEmpty()
        // Formats made while speaking share one wait: past it the whole text is formatted now, which
        // is quicker than waiting longer for a model that is stuck.
        val formatDeadline = System.currentTimeMillis() + FORMAT_WAIT_MS
        fun formatLeft() = (formatDeadline - System.currentTimeMillis()).coerceAtLeast(1)
        val waitStarted = System.currentTimeMillis()
        if (spec != null) {
            if (specFormat == null || specFormat.first !== spec) return null
            when (val f = withTimeoutOrNull(formatLeft()) { specFormat.second.await() } ?: PieceFormat.Unavailable) {
                PieceFormat.Unavailable -> {
                    trace?.note("the tail speculation's formatting was not ready or failed; the whole text was formatted at release")
                    return null
                }
                PieceFormat.Empty -> Unit
                is PieceFormat.Done -> {
                    val at = lastSentenceStart(f.result.text)
                    val head = f.result.text.substring(0, at).trim()
                    if (tail.isEmpty()) specHead = f.result
                    else {
                        if (head.isNotEmpty()) specHead = f.result.copy(text = head)
                        tailText = joinSeam(f.result.text.substring(at), tail).text
                        tailBefore = head.ifEmpty { tailBefore }
                    }
                }
            }
        }
        val lastPiece = seamContext(tailBefore)
        val tailInput = input.copy(
            transcript = tailText,
            context = input.context.copy(
                precedingText = listOfNotNull(input.context.precedingText, lastPiece.ifEmpty { null }).joinToString(" ").ifEmpty { null }
            )
        )
        val ready = preformatted?.takeIf { it.first == tailText }?.second
        val tailJob = when {
            tailText.isEmpty() -> null
            ready != null -> kotlinx.coroutines.CompletableDeferred(Result.success(ready))
            // A few words after formatted text: rule-based formatting, no model round trip.
            countWords(tail) in 1..SHORT_TAIL_WORDS && (specHead != null || texts.isNotEmpty()) ->
                scope.async { runCatching { Engine.formatTranscript(tailInput, null) } }
            else -> scope.async { runCatching { formatter.format(tailInput) } }
        }
        val done = withTimeoutOrNull(formatLeft()) { specs.awaitAll() }
        trace?.step("waiting for formatting done while speaking", System.currentTimeMillis() - waitStarted)
        if (done == null) {
            trace?.note("a piece's formatting was still running after ${FORMAT_WAIT_MS} ms; the whole text was formatted at release")
            return null
        }
        if (done.any { it is PieceFormat.Unavailable }) {
            trace?.note("a piece could not be formatted while speaking; the whole text was formatted at release")
            return null
        }
        val parts = done.filterIsInstance<PieceFormat.Done>().map { it.result }.toMutableList()
        specHead?.let { parts.add(it) }
        if (tailJob != null) parts.add(tailJob.await().getOrElse { return null }.let { it.copy(text = stripEcho(it.text, lastPiece)) })
        if (parts.isEmpty()) return null
        Log.i(TAG, "${done.size} piece(s) formatted while speaking; tail formatted at release")
        val worst = parts.maxBy { it.status.outcome.ordinal.let { o -> listOf(0, 2, 1, 3, 4)[o] } }
        val stages = LinkedHashSet<String>().apply { parts.forEach { addAll(it.stages) } }.toList()
        return FormatResult(
            text = joinPieces(parts.map { it.text }).text,
            pressEnter = parts.last().pressEnter,
            // A piece the model left as it was, or a short tail formatted by rules, does not make the
            // dictation "not formatted" (desktop: joinFormatted; Oct 15: 13 formatted pieces, llmUsed=false).
            status = (parts.firstOrNull { it.status.outcome == FormatOutcome.USED }
                ?.takeIf { worst.status.outcome in setOf(FormatOutcome.USED, FormatOutcome.SKIPPED_CLEAN, FormatOutcome.SKIPPED) }
                ?.status?.copy(detail = "${parts.size} pieces, formatted while speaking")) ?: worst.status,
            modelText = if (parts.all { it.modelText != null }) joinPieces(parts.map { it.modelText!! }).text else null,
            llmMs = parts.last().llmMs,
            stages = stages,
            limit = parts.firstNotNullOfOrNull { it.limit },
            // The release's own model calls (the tail); the pieces' ran while the user spoke.
            calls = if (tailJob != null) parts.last().calls else emptyList()
        )
    }

    /**
     * The whole transcript through the formatting model. A long one (pieces not formatted while
     * recording) goes in groups, two at a time, each told the end of the one before: one huge
     * request would be the slowest, and its answer is capped (desktop: formatLong).
     */
    private suspend fun formatLong(router: InferenceRouter, input: FormatInput): FormatResult {
        val formatter = router.formatter()
        if (countWords(input.transcript) <= LONG_FORMAT_WORDS) return formatter.format(input)
        val groups = formatGroups(input.transcript)
        val gate = kotlinx.coroutines.sync.Semaphore(2)
        val parts = kotlinx.coroutines.coroutineScope {
            groups.mapIndexed { i, g ->
                async {
                    val prior = if (i > 0) seamContext(groups[i - 1]) else ""
                    val ctx = input.context.copy(
                        precedingText = listOfNotNull(input.context.precedingText, prior.ifEmpty { null }).joinToString(" ").ifEmpty { null }
                    )
                    gate.withPermit { formatter.format(input.copy(transcript = g, context = ctx)) }
                }
            }.awaitAll()
        }
        Log.i(TAG, "long transcript formatted in ${parts.size} groups")
        val worst = parts.maxBy { it.status.outcome.ordinal.let { o -> listOf(0, 2, 1, 3, 4)[o] } }
        return FormatResult(
            text = joinPieces(parts.map { it.text }).text,
            pressEnter = parts.last().pressEnter,
            status = worst.status,
            modelText = if (parts.all { it.modelText != null }) joinPieces(parts.map { it.modelText!! }).text else null,
            llmMs = parts.sumOf { it.llmMs },
            stages = LinkedHashSet<String>().apply { parts.forEach { addAll(it.stages) } }.toList(),
            limit = parts.firstNotNullOfOrNull { it.limit },
            calls = parts.flatMap { it.calls }
        )
    }

    /**
     * What the one-call release needs, known at release without waiting: the speculation's formatted
     * last sentence (the prefix the tail continues) and the formatting request for the tail. Null
     * when the speculation is not formatted yet (the two-call path handles it).
     */
    private suspend fun releasePlan(
        streamed: Streamed,
        specOk: Boolean,
        style: FormatStyle,
        app: AppContext,
        focusedPackage: String,
        s: MurmurSettings,
        context: Context
    ): Pair<String?, org.json.JSONObject>? {
        if (!specOk) return null
        val spec = tailSpecFormat ?: return null
        if (spec.first !== streamed.specText || !spec.second.isCompleted) return null
        val f = spec.second.await() as? PieceFormat.Done ?: return null
        val at = lastSentenceStart(f.result.text)
        val head = f.result.text.substring(0, at).trim()
        if (head.isEmpty()) return null
        val input = formatInputFor("", FormattingMode.SMART, style, app, focusedPackage, s, context, precedingText = seamContext(head).ifEmpty { null })
        return f.result.text.substring(at) to input.toJson().apply { remove("transcript") }
    }

    private suspend fun process(
        run: Run,
        pcm: ShortArray,
        s: MurmurSettings,
        context: Context,
        router: InferenceRouter,
        streamed: Streamed? = null,
        /** The dictation ended on its stop phrase, which the transcript therefore ends with. */
        phraseHeard: Boolean = false
    ) {
        val trace = run.trace
        val recordMs = run.recordMs
        // The destination's style is settled before the speech request: a per-app rule may pick the
        // speed, which the speech model is asked for and which decides whether the formatting model runs.
        val focusedPackage = sink?.focusedPackage() ?: ""
        val focusedLabel = appLabel(context, focusedPackage)
        val app: AppContext = classifyPackage(focusedPackage, focusedLabel)
        val style = resolveStyle(s, app)
        style.rule?.let { Log.i(TAG, "per-app rule \"${it.match}\" applies to $focusedPackage") }
        // 1. STT, and make sure the transcript reaches the end of the speech. The router decides
        // whether the clip goes to the instance's model or the user's own provider.
        val sttStarted = System.currentTimeMillis()
        val resolved = router.stt(speed = style.speed)
        // The dictionary and the snippet triggers prime the speech model, unless the user turned
        // the bias off (then no prompt goes at all, as on the desktop).
        val prompt = if (s.useDictionaryPrompt) buildSttPrompt(s.dictionaryTerms + s.snippetTriggers) else null
        val threshold = adaptiveThreshold(pcm, SAMPLE_RATE, -48.0)
        suspend fun runStt(clip: ShortArray) = transcribeComplete(
            pcm = clip,
            sampleRate = SAMPLE_RATE,
            speechEndSec = lastVoicedSec(clip, SAMPLE_RATE, threshold),
            thresholdDb = threshold,
            prompt = prompt,
            // Resumed tails keep the style hint but never the vocabulary: a prompt that ends with a
            // term the speaker says next is exactly what makes Whisper stop early.
            tailPrompt = if (prompt != null) STT_BASE_PROMPT else null,
            log = { Log.w(TAG, it) }
        ) { wav, p -> router.transcribe(resolved, wav, p) }
        // The whole recording at once (no streamed pieces, pieces that failed, Retry). A long one
        // goes up in pieces cut at pauses, never as one request: the gateway refuses clips over
        // 600 s, and one huge request is the slowest way to get a 30-minute dictation back.
        suspend fun runWholeUntimed(): CompleteResult {
            if (pcm.size.toDouble() / SAMPLE_RATE <= LONG_CLIP_SEC) return runStt(pcm)
            val started = System.currentTimeMillis()
            val texts = transcribeInPieces(pcm, SAMPLE_RATE, -48.0) { clip, _ -> runStt(clip).output.text }
            val joined = joinPieces(texts)
            Log.i(TAG, "${pcm.size / SAMPLE_RATE} s transcribed in ${texts.size} piece(s)")
            return CompleteResult(TranscribeOutput(text = joined.text, latencyMs = System.currentTimeMillis() - started), 0, 0.0, Coverage(null, 0.0, false))
        }
        suspend fun runWhole(): CompleteResult = trace.timed("speech (whole recording)") { runWholeUntimed() }
        var streamedTexts: List<String>? = null
        // The tail formatted on the gateway in the same call as its speech (text it formatted, result).
        var preformatted: Pair<String, FormatResult>? = null
        var streamedTail: String? = null
        var streamedSpec: Deferred<String>? = null
        // With a tail speculation, only the audio after its pause goes up now; if it failed, the
        // whole stretch after the pieces does.
        // Everything streamed shares one wait (STREAM_WAIT_MS); past it the whole dictation goes up.
        val streamDeadline = System.currentTimeMillis() + STREAM_WAIT_MS
        fun streamLeft() = (streamDeadline - System.currentTimeMillis()).coerceAtLeast(1)
        // A speculation still running at release is dropped, not waited for: the tail was sent only after
        // it came back, which put the background-tier speculation on the critical path (2-3 s releases).
        val specOk = streamed?.specText?.let { runCatching { withTimeout(SPEC_RELEASE_GRACE_MS) { it.await() } }.isSuccess } == true
        val specWaitMs = System.currentTimeMillis() - (streamDeadline - STREAM_WAIT_MS)
        Log.i(TAG, "release: spec ${if (streamed?.specText == null) "none" else if (specOk) "used" else "dropped"} after $specWaitMs ms")
        if (streamed?.specText != null) {
            trace.step("waiting for the tail speculation", specWaitMs)
            if (!specOk) trace.note("the tail speculation was still running at release and was dropped")
        }
        val from = if (specOk) streamed!!.specSamples!! else streamed?.samples ?: 0
        val complete = if (streamed != null && (from in 1 until pcm.size)) {
            // Only the audio after the pieces goes up now, alongside waiting for the pieces.
            val rest = pcm.copyOfRange(from, pcm.size)
            // One call for the tail when the rest is formatted already: speech, then formatting of the
            // speculation's last sentence + the tail, on the gateway (no second phone round trip).
            val plan = if (run.mode != DictationMode.COMMAND && style.effectiveMode == FormattingMode.SMART && murmurFormatting(context))
                releasePlan(streamed, specOk, style, app, focusedPackage, s, context) else null
            val tail = if (Wav.peakDb(rest) < -48.0) null else scope.async {
                runCatching {
                    val answer = plan?.let { p ->
                        runCatching { router.dictateRelease(resolved, Wav.encodePcm16(rest, SAMPLE_RATE), prompt, p.first, p.second) }
                            .onFailure { Log.w(TAG, "one-call release failed; using two calls", it) }.getOrNull()
                    }
                    if (answer == null) trace.timed("speech (tail)") { runStt(rest) }
                    else {
                        answer.format?.let { preformatted = answer.transcript to FormatResult.fromJson(it) }
                        Log.i(TAG, "tail in one call: ${answer.stt.latencyMs} ms${if (answer.rules) " (short tail, rules)" else ""}")
                        trace.path = "one-call"
                        trace.step("speech + formatting of the tail (one call)", answer.stt.latencyMs)
                        trace.call(answer.stt.trace)
                        preformatted?.second?.calls?.let { trace.calls(it) }
                        if (answer.rules) trace.note("short tail formatted by rules")
                        CompleteResult(answer.stt, 0, 0.0, Coverage(null, 0.0, false))
                    }
                }
            }
            if (trace.path != "retry") trace.path = "streamed"
            val piecesStarted = System.currentTimeMillis()
            val texts = runCatching { withTimeout(streamLeft()) { streamed.texts() } }
            trace.step("waiting for pieces sent while speaking", System.currentTimeMillis() - piecesStarted)
            trace.pieces = texts.getOrNull()?.size ?: 0
            // The tail is new audio, not a stalled piece: it gets the stream wait plus its own STT time.
            val tailResult = tail?.let { t -> withTimeoutOrNull(streamLeft() + 10_000) { t.await() } ?: Result.failure(ReleaseTimeoutException()) }
            if (texts.isFailure || tailResult?.isFailure == true) {
                Log.w(TAG, "a streamed piece failed; transcribing the whole dictation", texts.exceptionOrNull() ?: tailResult?.exceptionOrNull())
                trace.note(
                    if (texts.isFailure) "a piece sent while speaking failed or ran past ${STREAM_WAIT_MS} ms; the whole recording was transcribed again"
                    else "the tail failed; the whole recording was transcribed again"
                )
                runWhole()
            } else {
                var last = tailResult?.getOrNull()
                // A quiet tail can come back as a stock phrase nobody said ("Thank you.").
                if (last != null && Hallucination.isSilencePhrase(last.output.text) &&
                    Wav.voicedMs(rest, SAMPLE_RATE, Hallucination.VOICED_DB) < Hallucination.MIN_SPEECH_MS
                ) {
                    Log.i(TAG, "dropped a stock phrase from a quiet tail")
                    last = last.copy(output = last.output.copy(text = ""))
                }
                val specText = if (specOk) streamed.specText!!.await() else null
                if (specOk) streamedSpec = streamed.specText
                streamedTexts = texts.getOrThrow()
                streamedTail = last?.output?.text?.trim() ?: ""
                val joined = joinPieces(texts.getOrThrow() + listOfNotNull(specText, last?.output?.text)).text
                Log.i(TAG, "${texts.getOrThrow().size} piece(s) sent while recording${if (specOk) " + tail speculation" else ""}; ${rest.size / SAMPLE_RATE} s sent at release")
                val base = last ?: CompleteResult(TranscribeOutput(text = "", latencyMs = 0), 0, 0.0, Coverage(null, 0.0, false))
                base.copy(output = base.output.copy(text = joined, spans = null))
            }
        } else runWhole()
        val stt = complete.output
        if (trace.path != "one-call") trace.call(stt.trace)
        if (complete.resumed > 0) {
            Log.i(TAG, "transcript recovered ${"%.1f".format(complete.recoveredSec)}s of speech in ${complete.resumed} extra request(s)")
            trace.note("the transcript stopped short; ${complete.resumed} extra speech request(s) recovered the rest")
        }
        var raw = stt.text.trim()
        // The spoken stop phrase ends the dictation; it is not part of the text. Said across the
        // seam between a streamed piece and the tail, the whole transcript is formatted instead.
        if (s.stopPhraseEnabled) StopPhrase.strip(raw, s.stopPhrase, phraseHeard)?.let { stripped ->
            Log.i(TAG, "stop phrase cut from the end of the transcript")
            raw = stripped
            val tail = streamedTail?.let { StopPhrase.strip(it, s.stopPhrase, phraseHeard) }
            if (tail != null) streamedTail = tail else streamedTexts = null
        }
        val sttMs = System.currentTimeMillis() - sttStarted
        trace.step("speech (total)", sttMs)
        val speedNote = stt.speed?.let { sp ->
            if (sp.fellBack) " speed=${sp.used} (asked ${sp.requested}, ${sp.fallback ?: "fallback"})" else " speed=${sp.used}"
        } ?: ""
        Log.i(TAG, "stt done in ${stt.latencyMs}ms$speedNote: ${raw.take(80)}")
        if (raw.isEmpty() ||
            (stt.noSpeechProb != null && stt.noSpeechProb > 0.85 && countWords(raw) <= 2) ||
            (Hallucination.isSilencePhrase(raw) && Wav.voicedMs(pcm, SAMPLE_RATE, Hallucination.VOICED_DB) < Hallucination.MIN_SPEECH_MS)
        ) {
            recordFailure(
                context, s, run, raw, "Nothing heard", StageTimings(recordMs = recordMs, sttMs = sttMs),
                provider = resolved.provider, model = resolved.cfg.model
            )
            showError(context, "Nothing heard", run)
            return
        }

        // 2. Text. The engine gets the raw transcript plus everything it should know about the
        // destination; against a Murmur instance it runs on the gateway, otherwise here.
        val formatStarted = System.currentTimeMillis()
        var final: String
        var pressEnter = false
        var stages: List<String> = emptyList()
        var llm = LlmOutcome.SKIPPED
        var llmDetail: String? = null
        var llmMs = 0L
        // The text goes in, but the formatting model was paused or refused on a plan limit.
        var softLimit: LimitNotice? = null
        if (run.mode == DictationMode.COMMAND) {
            // The transcript is an instruction for the selected text (desktop: session.ts command
            // mode): the model applies it and the answer replaces the selection, nothing else runs.
            val selection = run.selection
            if (selection == null || selection.text.isBlank()) {
                recordFailure(context, s, run, raw, NO_SELECTION, StageTimings(recordMs = recordMs, sttMs = sttMs), resolved.provider, resolved.cfg.model)
                showError(context, NO_SELECTION, run)
                return
            }
            _state.value = DictationState.Processing("Editing…", run.mode)
            val cfg = router.llm().cfg
            if (cfg.baseUrl.isEmpty() || cfg.model.isEmpty()) {
                recordFailure(context, s, run, raw, NO_COMMAND_MODEL, StageTimings(recordMs = recordMs, sttMs = sttMs), resolved.provider, resolved.cfg.model)
                showError(context, NO_COMMAND_MODEL, run)
                return
            }
            val messages = Prompt.buildCommandMessages(
                CommandPromptInput(
                    selection = selection.text,
                    instruction = raw,
                    category = app.category,
                    dictionary = s.dictionaryEntries.map { DictionaryTerm(it.word, it.aliases, it.fuzzy) },
                    language = s.language
                )
            )
            val answer = router.complete(cfg, messages, maxTokens = Prompt.commandMaxTokens(selection.text))
            llmMs = System.currentTimeMillis() - formatStarted
            val edited = Verify.cleanModelOutput(answer.text, selection.text)
            if (edited.isEmpty()) {
                val timings = StageTimings(recordMs = recordMs, sttMs = sttMs, llmMs = llmMs)
                recordFailure(context, s, run, raw, "The model returned nothing", timings, resolved.provider, resolved.cfg.model)
                showError(context, "The model returned nothing", run)
                return
            }
            final = edited
            stages = listOf("command")
            llm = LlmOutcome.USED
            llmDetail = null
        } else if (style.mode == FormattingMode.OFF) {
            final = raw + if (style.trailingSpace) " " else ""
            llmDetail = "formatting off"
        } else {
            // Fast is the quick path: the speech model's text gets the rule-based Light cleanup and
            // goes in, the formatting model is never asked, and History says that is why.
            val mode = style.effectiveMode
            // A copy-only retry has no target field; what is focused is Murmur's own screen.
            val preceding = if (run.insert && mode == FormattingMode.SMART) runCatching { sink?.precedingText() }.getOrNull() else null
            val input = formatInputFor(raw, mode, style, app, focusedPackage, s, context, preceding)
            var formatted: FormatResult
            if (mode != FormattingMode.SMART) {
                formatted = Engine.formatTranscript(input, null)
                if (style.skipsModelForSpeed) formatted = formatted.copy(status = FormatStatus(FormatOutcome.SKIPPED, FAST_SKIP_DETAIL, 0))
            } else {
                _state.value = DictationState.Processing("Formatting…")
                // A formatting model that cannot be reached (signed out of Murmur, no token, gateway
                // down) or refused on a plan limit is not an error for the dictation: the rule-based
                // text goes in and History says why. A Murmur instance past the fair-use cap answers
                // with the rule-based text itself and says which limit paused the model.
                formatted = try {
                    (formatWithSpeculation(router, input, streamedTexts, streamedTail, streamedSpec, preformatted, trace)
                        ?: trace.timed("formatting (whole text)") { formatLong(router, input) })
                        .also { softLimit = it.limit }
                } catch (e: Exception) {
                    Log.w(TAG, "formatting unavailable, using rule-based text: ${e.message}")
                    softLimit = planLimitOf(e)
                    Engine.formatTranscript(input, null)
                        .copy(status = FormatStatus(FormatOutcome.FAILED, friendlyError(e), 0))
                }
            }
            if (mode == FormattingMode.SMART) {
                if (trace.path != "one-call") trace.calls(formatted.calls)
                trace.step("formatting (total)", System.currentTimeMillis() - formatStarted)
                when (formatted.status.outcome) {
                    FormatOutcome.FAILED -> trace.note("formatting failed, rule-based text used: ${formatted.status.detail ?: "no detail"}")
                    FormatOutcome.REJECTED -> trace.note("the model's text was rejected (${formatted.status.detail ?: "guard"}); rule-based text used")
                    else -> Unit
                }
            }
            val finished = finish(formatted.text, app.category, s.dictionaryEntries, style.trailingSpace, snippets = s.snippets)
            final = finished.text
            pressEnter = formatted.pressEnter
            stages = formatted.stages + finished.stages
            llmMs = formatted.llmMs
            llm = when (formatted.status.outcome) {
                FormatOutcome.USED -> LlmOutcome.USED
                FormatOutcome.REJECTED -> LlmOutcome.REJECTED
                FormatOutcome.FAILED -> LlmOutcome.FAILED
                FormatOutcome.SKIPPED -> LlmOutcome.SKIPPED
                FormatOutcome.SKIPPED_CLEAN -> LlmOutcome.SKIPPED_CLEAN
            }
            llmDetail = formatted.status.detail ?: formatted.status.retriedAfter?.let { "used after a strict retry ($it)" }
            when (formatted.status.outcome) {
                FormatOutcome.USED -> Log.i(TAG, "model formatting used (${formatted.status.attempts} attempt(s), ${llmMs}ms)")
                FormatOutcome.REJECTED -> Log.w(TAG, "model output rejected (${formatted.status.detail}); using rule-based text")
                FormatOutcome.FAILED -> Log.w(TAG, "model formatting failed, using rule-based text: ${formatted.status.detail}")
                FormatOutcome.SKIPPED_CLEAN -> Log.i(TAG, "model skipped: transcript already clean, rule-based text used")
                FormatOutcome.SKIPPED -> if (style.skipsModelForSpeed) Log.i(TAG, "model skipped: Fast speed, rule-based text used")
            }
        }
        val formatMs = (System.currentTimeMillis() - formatStarted - llmMs).coerceAtLeast(0)

        val timings = StageTimings(recordMs = recordMs, sttMs = sttMs, formatMs = formatMs, llmMs = llmMs)
        if (final.isBlank()) {
            recordFailure(context, s, run, raw, "Nothing to insert", timings, resolved.provider, resolved.cfg.model)
            showError(context, "Nothing to insert", run)
            return
        }

        // 4. Inject into the focused field, or only copy when the text has nowhere to go right now.
        val currentSink = sink
        if (run.insert && currentSink == null) {
            recordFailure(context, s, run, raw, "Accessibility service not running", timings, resolved.provider, resolved.cfg.model)
            showError(context, "Accessibility service not running", run)
            return
        }
        _state.value = DictationState.Processing(if (run.insert) "Inserting…" else "Copying…", run.mode)
        val injectStarted = System.currentTimeMillis()
        val selection = run.selection
        val error = when {
            run.insert && currentSink != null && run.mode == DictationMode.COMMAND && selection != null ->
                currentSink.replaceSelection(selection, final)
            run.insert && currentSink != null -> currentSink.insert(final, pressEnter)
            else -> copyToClipboard(context, final)
        }
        val wordCount = countWords(final)
        val now = System.currentTimeMillis()
        // The audio stays with a successful dictation only if the user wants recordings kept.
        val recording = if (error == null && !s.keepRecordings) null else run.recording
        val entry = HistoryEntry(
            id = run.id,
            createdAt = run.previous?.createdAt ?: now,
            mode = run.mode,
            rawText = raw,
            finalText = if (error == null) final.trimEnd() else "",
            wordCount = if (error == null) wordCount else 0,
            speechMs = recordMs,
            appName = if (run.insert) focusedLabel else run.previous?.appName,
            provider = resolved.provider,
            model = resolved.cfg.model,
            speed = style.speed.id,
            sttSpeed = stt.speed,
            injected = error == null && run.insert,
            llmUsed = llm == LlmOutcome.USED,
            llm = llm,
            llmDetail = llmDetail,
            stages = stages,
            timings = timings.copy(injectMs = now - injectStarted, totalMs = now - stoppedAt),
            error = error,
            recording = recording,
            attempts = run.attempts,
            trace = trace.also { it.step(if (run.insert) "inserting" else "copying", now - injectStarted) }.build()
        )
        Log.i(TAG, "trace: ${entry.trace?.describe()?.replace("\n", " |")}")
        val history = HistoryStore.get(context)
        if (run.previous != null) history.replace(entry) else history.add(entry)
        if (error == null) {
            Log.i(TAG, "${if (run.insert) "inserted" else "copied"} $wordCount words in ${entry.timings.totalMs}ms${if (run.attempts > 1) " (attempt ${run.attempts})" else ""}")
            Haptics.play(context, Haptic.DONE)
            showTransient(
                DictationState.Success(if (!run.insert) "Copied" else if (run.mode == DictationMode.COMMAND) "Edited" else "Inserted", softLimit),
                if (softLimit != null) SOFT_LIMIT_HOLD_MS else 1500
            )
            SettingsStore.get(context).update { current ->
                current.copy(stats = current.stats.record(entry.wordCount, entry.speechMs, DictationStats.localDay(now)))
            }
            CloudSync.get()?.recordSession(sessionId = entry.id, words = entry.wordCount, speechMs = entry.speechMs)
        } else {
            showError(context, error, run)
        }
    }

    /** @return null on success, or a user-facing error message. */
    private fun copyToClipboard(context: Context, text: String): String? = try {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Murmur", text))
        null
    } catch (e: Exception) {
        Log.w(TAG, "clipboard write failed", e)
        "Could not copy the text"
    }

    /**
     * A dictation that produced nothing still shows up in History, with what went wrong. Before the
     * router resolved a connection (it may be what failed), the entry names the model the settings
     * would have used.
     */
    private fun recordFailure(
        context: Context,
        s: MurmurSettings,
        run: Run,
        raw: String,
        error: String,
        timings: StageTimings = StageTimings(recordMs = run.recordMs),
        provider: String = configuredProvider(context, s),
        model: String = configuredModel(context, s)
    ) {
        val now = System.currentTimeMillis()
        val previous = run.previous
        val entry = HistoryEntry(
            id = run.id.ifEmpty { UUID.randomUUID().toString() },
            createdAt = previous?.createdAt ?: now,
            mode = run.mode,
            rawText = raw.ifEmpty { previous?.rawText ?: "" },
            finalText = "",
            wordCount = 0,
            speechMs = timings.recordMs,
            appName = if (run.insert) appLabel(context, sink?.focusedPackage() ?: "") else previous?.appName,
            provider = provider,
            model = model,
            injected = false,
            llmUsed = false,
            timings = timings.copy(totalMs = (now - stoppedAt).coerceAtLeast(0)),
            error = error,
            recording = run.recording,
            attempts = run.attempts,
            trace = run.trace.build().takeIf { it.steps.isNotEmpty() || it.notes.isNotEmpty() || it.calls.isNotEmpty() }
        )
        val history = HistoryStore.get(context)
        if (previous != null) history.replace(entry) else history.add(entry)
    }

    private fun murmurSpeech(context: Context): Boolean =
        InferenceRouter.get(context).routing().stt == InferenceSource.MURMUR

    private fun configuredProvider(context: Context, s: MurmurSettings): String =
        if (murmurSpeech(context)) Inference.PROVIDER else s.sttKind.id

    private fun configuredModel(context: Context, s: MurmurSettings): String =
        if (murmurSpeech(context)) Inference.STT_MODEL else modelName(s)

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

    /**
     * A dictation that ended before it reached a model (too short, nothing but silence, no field to
     * edit, a microphone that would not open): a notice on the pill, felt as an error by the hand
     * but, as on the desktop, without the error sound.
     */
    private fun showNotice(context: Context, message: String) {
        Haptics.play(context, Haptic.ERROR)
        showTransient(DictationState.Error(message))
    }

    /**
     * A failure the user can do something about: when the audio was stored the pill offers to send
     * it again and waits much longer for the answer than a plain message would. A plan limit is
     * explained on the pill, with the ways forward, and waits longer still; so is a Murmur service
     * that is down, with Retry for when it is back.
     */
    private fun showError(
        context: Context,
        message: String,
        run: Run,
        limit: LimitNotice? = null,
        service: ServiceNotice? = null
    ) {
        Haptics.play(context, Haptic.ERROR)
        Cues.play(context, Cue.ERROR)
        val retryId = run.id.takeIf { run.recording != null }
        val hold = when {
            limit != null || service != null -> LIMIT_HOLD_MS
            retryId != null -> RETRY_HOLD_MS
            else -> 2500L
        }
        if (service != null) Log.w(TAG, "Murmur ${service.service} service unavailable (${service.reason}); recording kept for Retry")
        showTransient(DictationState.Error(message, retryId, limit, service), hold)
    }

    /** The plan limit behind an error, when a Murmur instance refused (or paused) on one. */
    fun planLimitOf(err: Throwable): LimitNotice? = (err as? SttException)?.planLimit

    /** The service notice behind an error, when a Murmur instance said its provider is down. */
    fun serviceNoticeOf(err: Throwable): ServiceNotice? = (err as? SttException)?.service

    private fun loadFixture(context: Context): ShortArray {
        val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
        val (pcm, rate) = Wav.decodePcm16(bytes)
        return Wav.resample(pcm, rate, SAMPLE_RATE)
    }

    fun friendlyError(err: Throwable): String = when {
        err is SttException -> err.friendly()
        err is ReleaseTimeoutException -> err.message!!
        err is SecurityException -> "Microphone permission missing — grant it in Murmur"
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            err is android.app.ForegroundServiceStartNotAllowedException ->
            "Android blocked background recording — open Murmur once and try again"
        else -> err.message ?: "Something went wrong"
    }
}

/** A release tail of at most this many words is formatted by rules (mirrors SHORT_TAIL_WORDS in the gateway). */
const val SHORT_TAIL_WORDS = 6

/** What the formatter is told about a piece of a longer dictation that is not the last. */
private const val PIECE_NOTE =
    "This transcript is one part of a longer dictation and may stop mid-sentence; if it does, leave the end unpunctuated."

/** Audio kept after the end of the stop phrase when it ended the session (0.3 s). */
private const val PHRASE_TAIL_SAMPLES = SAMPLE_RATE * 3 / 10

/** How long release waits for a tail speculation that is still running before sending the whole tail. */
private const val SPEC_RELEASE_GRACE_MS = 150L
