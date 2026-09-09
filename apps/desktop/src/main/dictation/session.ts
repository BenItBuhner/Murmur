import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HotkeyAction } from '@core/hotkey/engine'
import { adaptiveThreshold, analyze, trimSilence } from '@core/audio/vad'
import {
  getSttProvider,
  SttError,
  transcribeComplete,
  type CompleteResult,
  type TranscribeOutput
} from '@core/stt'
import type { LlmConfig } from '@core/llm/client'
import { STT_BASE_PROMPT, buildSttPrompt } from '@core/text/dictionary'
import { runPipeline, type PipelineOptions, type PipelineResult } from '@core/text/pipeline'
import { buildCommandMessages, sanitizeLlmOutput } from '@core/text/llm-prompt'
import { smartFormat } from '@core/text/smart-format'
import {
  classifyApp,
  resolveStyle,
  type AppContext,
  type ResolvedStyle
} from '@core/text/app-context'
import { countWords } from '@core/text/util'
import { MURMUR_ERROR_CODES } from '@shared/inference'
import { sessionDurationLimitMs, type Settings } from '@shared/settings'
import type {
  ActiveWindowInfo,
  DictationMode,
  HistoryEntry,
  LlmStatus,
  OverlayState,
  StageTimings
} from '@shared/types'
import type { RetryResult, SoundName } from '@shared/ipc'
import { createLogger } from '../logger'
import { localDay } from '../cloud/reducers'
import type { Recorder } from '../audio/recorder'
import type { HookService } from '../hotkeys/hook'
import type { InferenceRouter, ResolvedStt } from '../inference/router'
import type { SettingsStore } from '../store/settings'
import type { HistoryStore } from '../store/history'
import type { RecordingStore } from '../store/recordings'
import { injectText, readSelection, type InjectResult } from '../inject'

const log = createLogger('session')
const SAMPLE_RATE = 16000

interface ActiveSession {
  id: string
  mode: DictationMode
  startedAt: number
  locked: boolean
  windowInfo: Promise<ActiveWindowInfo>
  elapsedTimer: NodeJS.Timeout | null
  maxTimer: NodeJS.Timeout | null
}

/** One run of the pipeline: a dictation that was just spoken, or a stored one sent again. */
interface ProcessJob {
  id: string
  mode: DictationMode
  windowInfo: Promise<ActiveWindowInfo>
  /** File name of the stored audio, when it was kept. */
  recording?: string
  /** Sent again: the failed entry this run replaces. */
  previous?: HistoryEntry
  /** How many times this audio has now been sent for transcription. */
  attempts: number
  /**
   * Type the text into the focused field. A retry started from the History page only copies it:
   * the focused field would be the settings window itself.
   */
  inject: boolean
}

type ProcessOutcome =
  | { ok: true; entry: HistoryEntry }
  /** `recorded`: the failure is in History (with the audio) and can be sent again. */
  | { ok: false; error: string; recorded: boolean }

export interface SessionDeps {
  settings: SettingsStore
  history: HistoryStore
  recorder: Recorder
  recordings: Pick<RecordingStore, 'save' | 'read' | 'has' | 'delete'>
  hook: HookService
  /** Where speech and formatting requests go (the instance's models or the user's own provider). */
  inference: InferenceRouter
  overlay: { setState: (s: OverlayState) => void; playSound: (n: SoundName) => void }
  getActiveWindow: () => Promise<ActiveWindowInfo>
}

/** Placeholder the smart-formatting stage reads as "no model configured". */
const NO_LLM: LlmConfig = { baseUrl: '', apiKey: '', model: '', timeoutMs: 8000 }

/**
 * Orchestrates one dictation from hotkey to inserted text and records where the time went.
 * Recording of a new session may begin while the previous one is still transcribing; insertion
 * is serialized through a queue so text always lands in the order it was spoken.
 */
export class DictationController extends EventEmitter {
  enabled = true
  private active: ActiveSession | null = null
  private processing = 0
  private injectQueue: Promise<void> = Promise.resolve()

  constructor(private deps: SessionDeps) {
    super()
  }

  get isListening(): boolean {
    return this.active !== null
  }

  get isBusy(): boolean {
    return this.processing > 0
  }

  handle(action: HotkeyAction): void {
    if (!this.enabled) return
    switch (action.type) {
      case 'start':
        this.start(action.mode)
        break
      case 'lock':
        this.lock()
        break
      case 'stop':
        void this.stop()
        break
      case 'cancel':
        this.cancel()
        break
    }
  }

  /** Tray/UI button: toggles a hands-free session. */
  toggle(): void {
    if (!this.enabled) return
    if (this.active) {
      this.deps.hook.notifySessionEnded()
      void this.stop()
    } else {
      this.deps.hook.notifySessionStarted('hands-free')
      this.start('hands-free')
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled && this.active) this.cancel()
    if (!enabled) this.deps.overlay.setState({ phase: 'disabled' })
    else this.deps.overlay.setState({ phase: 'idle' })
    this.emit('enabled', enabled)
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  private start(mode: DictationMode): void {
    if (this.active) {
      log.debug('start ignored: session already active')
      return
    }
    const s = this.deps.settings.get()
    const id = randomUUID()
    const session: ActiveSession = {
      id,
      mode,
      startedAt: performance.now(),
      locked: mode === 'hands-free',
      windowInfo: this.deps.getActiveWindow().catch(() => ({ title: '', app: '' })),
      elapsedTimer: null,
      maxTimer: null
    }
    this.active = session
    // Audio first: every millisecond before capture starts is a clipped first word.
    this.deps.recorder.start(id, mode !== 'command' && s.audio.preBufferMs > 0)
    this.deps.overlay.setState({ phase: 'listening', mode, locked: session.locked, elapsedSec: 0 })
    if (s.general.sounds) this.deps.overlay.playSound(mode === 'command' ? 'lock' : 'start')
    session.elapsedTimer = setInterval(() => {
      if (this.active !== session) return
      this.deps.overlay.setState({
        phase: 'listening',
        mode: session.mode,
        locked: session.locked,
        elapsedSec: Math.round((performance.now() - session.startedAt) / 1000)
      })
    }, 1000)
    const durationLimitMs = sessionDurationLimitMs(s.audio)
    if (durationLimitMs !== null) {
      session.maxTimer = setTimeout(() => {
        if (this.active === session) {
          log.info('max duration reached; stopping')
          this.deps.hook.notifySessionEnded()
          void this.stop()
        }
      }, durationLimitMs)
    }
    this.emit('state', 'listening')
    log.info(`session ${id.slice(0, 8)} start mode=${mode}`)
  }

  private lock(): void {
    if (!this.active) return
    this.active.locked = true
    if (this.active.mode === 'hold') this.active.mode = 'hands-free'
    this.deps.overlay.setState({
      phase: 'listening',
      mode: 'hands-free',
      locked: true,
      elapsedSec: Math.round((performance.now() - this.active.startedAt) / 1000)
    })
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('lock')
  }

  private cancel(): void {
    const session = this.active
    if (!session) return
    this.clearTimers(session)
    this.active = null
    this.deps.recorder.cancel(session.id)
    this.deps.overlay.setState({ phase: 'idle' })
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('cancel')
    this.emit('state', 'idle')
    log.info(`session ${session.id.slice(0, 8)} cancelled`)
  }

  private async stop(): Promise<void> {
    const session = this.active
    if (!session) return
    this.clearTimers(session)
    this.active = null
    const stopAt = performance.now()
    const s = this.deps.settings.get()
    if (s.general.sounds) this.deps.overlay.playSound('stop')
    this.deps.overlay.setState({ phase: 'processing', mode: session.mode })
    this.processing++
    this.emit('state', 'processing')
    const job: ProcessJob = {
      id: session.id,
      mode: session.mode,
      windowInfo: session.windowInfo,
      attempts: 1,
      inject: true
    }
    try {
      const pcm = await this.deps.recorder.stop(session.id)
      // Store the audio before anything can go wrong with it: a failed request is retried from
      // this file, and a kept recording is what History plays back.
      job.recording = await this.storeRecording(session.id, pcm)
      await this.process(job, pcm, stopAt, s)
    } catch (err) {
      log.error('session processing crashed', err)
      this.showError(friendlyError(err))
    } finally {
      this.releaseRecording(job)
      this.processing--
      if (!this.active && this.processing === 0) this.emit('state', 'idle')
    }
  }

  /**
   * Send a dictation's stored audio through the pipeline again. `inject` types the result where
   * the cursor is (the pill's Retry button, moments after the failure); without it the text is
   * copied to the clipboard and kept in History (the History page's Retry button).
   */
  async retry(id: string, opts: { inject: boolean }): Promise<RetryResult> {
    if (!this.enabled) return { ok: false, error: 'Murmur is paused' }
    if (this.active) return { ok: false, error: 'Finish the current dictation first' }
    const entry = this.deps.history.get(id)
    if (!entry) return { ok: false, error: 'This dictation is no longer in History' }
    if (entry.finalText) return { ok: false, error: 'This dictation already has its text' }
    if (!this.deps.recordings.has(entry.recording))
      return { ok: false, error: 'The recording of this dictation was not kept' }
    if (entry.mode === 'command' && !opts.inject)
      return { ok: false, error: 'A command needs its selection: retry it from the pill' }
    let pcm: Int16Array
    try {
      pcm = (await this.deps.recordings.read(entry.recording)).pcm
    } catch (err) {
      log.warn(`recording ${entry.recording} unreadable`, err)
      return { ok: false, error: 'The recording could not be read' }
    }
    const s = this.deps.settings.get()
    const stopAt = performance.now()
    this.deps.overlay.setState({ phase: 'processing', mode: entry.mode })
    this.processing++
    this.emit('state', 'processing')
    const job: ProcessJob = {
      id,
      mode: entry.mode,
      // From the pill the target field is still focused; from History the original app is only a
      // name, used for the style rules.
      windowInfo: opts.inject
        ? this.deps.getActiveWindow().catch(() => ({ title: '', app: '' }))
        : Promise.resolve({ title: '', app: entry.appName ?? '' }),
      recording: entry.recording,
      previous: entry,
      attempts: (entry.attempts ?? 1) + 1,
      inject: opts.inject
    }
    log.info(`session ${id.slice(0, 8)} retry #${job.attempts}${opts.inject ? '' : ' (copy only)'}`)
    try {
      const outcome = await this.process(job, pcm, stopAt, s)
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
    } catch (err) {
      log.error('retry crashed', err)
      this.showError(friendlyError(err), id)
      return { ok: false, error: friendlyError(err) }
    } finally {
      this.releaseRecording(job)
      this.processing--
      if (!this.active && this.processing === 0) this.emit('state', 'idle')
    }
  }

  private async storeRecording(id: string, pcm: Int16Array): Promise<string | undefined> {
    if (pcm.length < SAMPLE_RATE * 0.15) return undefined
    try {
      return await this.deps.recordings.save(id, pcm, SAMPLE_RATE)
    } catch (err) {
      log.warn('could not store the recording', err)
      return undefined
    }
  }

  /** After a run: audio that no History entry refers to any more has nothing to be kept for. */
  private releaseRecording(job: ProcessJob): void {
    if (!job.recording) return
    const entry = this.deps.history.get(job.id)
    if (entry?.recording !== job.recording) this.deps.recordings.delete(job.recording)
  }

  private clearTimers(session: ActiveSession): void {
    if (session.elapsedTimer) clearInterval(session.elapsedTimer)
    if (session.maxTimer) clearTimeout(session.maxTimer)
    session.elapsedTimer = null
    session.maxTimer = null
  }

  // ---- pipeline -----------------------------------------------------------------------------

  private async process(
    job: ProcessJob,
    pcm: Int16Array,
    stopAt: number,
    s: Settings
  ): Promise<ProcessOutcome> {
    const timings: StageTimings = {
      recordMs: Math.round((pcm.length / SAMPLE_RATE) * 1000),
      vadMs: 0,
      sttMs: 0,
      formatMs: 0,
      llmMs: 0,
      injectMs: 0,
      totalMs: 0
    }
    const windowInfo = await job.windowInfo
    const app: AppContext = classifyApp(windowInfo.app, windowInfo.title)
    const notice = (message: string): ProcessOutcome => {
      this.showNotice(message)
      return { ok: false, error: message, recorded: false }
    }
    const failure = (raw: string, resolved: ResolvedStt | null, error: string): ProcessOutcome => {
      this.recordFailure(job, raw, app, timings, resolved, error)
      this.showError(error, job.recording ? job.id : undefined)
      return { ok: false, error, recorded: true }
    }

    // 1. VAD
    let t = performance.now()
    let audio = pcm
    if (pcm.length < SAMPLE_RATE * 0.15) return notice('Too short')
    const threshold = adaptiveThreshold(pcm, SAMPLE_RATE, s.audio.silenceThresholdDb)
    const analysis = analyze(pcm, { sampleRate: SAMPLE_RATE, thresholdDb: threshold })
    if (s.audio.skipIfSilent && !analysis.hasSpeech) {
      timings.vadMs = Math.round(performance.now() - t)
      log.info(
        `session ${job.id.slice(0, 8)}: no speech (peak ${analysis.peakDb.toFixed(1)} dB, threshold ${threshold.toFixed(1)} dB)`
      )
      return notice('No speech detected')
    }
    // Where the speech ends in the audio we send: the transcript has to reach this far.
    let speechEndSec = analysis.lastVoicedMs / 1000
    if (s.audio.trimSilence) {
      const trimmed = trimSilence(pcm, {
        sampleRate: SAMPLE_RATE,
        thresholdDb: threshold,
        paddingMs: 300
      })
      audio = trimmed.pcm
      speechEndSec = (analysis.lastVoicedMs - trimmed.trimmedStartMs) / 1000
    }
    timings.vadMs = Math.round(performance.now() - t)

    // 2. STT
    t = performance.now()
    const tag = job.id.slice(0, 8)
    let resolved: ResolvedStt
    try {
      resolved = await this.deps.inference.stt()
    } catch (err) {
      timings.sttMs = Math.round(performance.now() - t)
      return failure('', null, friendlyError(err))
    }
    const prompt = s.stt.useDictionaryPrompt
      ? buildSttPrompt(
          s.dictionary,
          s.snippets.map((x) => x.trigger)
        )
      : undefined
    const keyterms = s.dictionary.map((d) => d.word)
    let stt: CompleteResult
    try {
      stt = await transcribeComplete(
        (wav, p) => this.transcribeWithFallback(wav, p, keyterms, resolved),
        {
          pcm: audio,
          sampleRate: SAMPLE_RATE,
          speechEndSec,
          thresholdDb: threshold,
          prompt,
          // Resumed tails keep the style hint but never the vocabulary: a prompt that ends with a
          // term the speaker says next is exactly what makes Whisper stop early.
          tailPrompt: prompt ? STT_BASE_PROMPT : undefined,
          log: (m) => log.warn(`session ${tag}: ${m}`)
        }
      )
    } catch (err) {
      timings.sttMs = Math.round(performance.now() - t)
      return failure('', resolved, friendlyError(err))
    }
    timings.sttMs = Math.round(performance.now() - t)
    if (stt.resumed)
      log.info(
        `session ${tag}: transcript recovered ${stt.recoveredSec.toFixed(1)}s of speech in ${stt.resumed} extra request(s)`
      )
    else if (stt.coverage.truncated)
      log.warn(
        `session ${tag}: transcript still looks short (${stt.coverage.reason}); inserting what came back`
      )
    const raw = stt.text.trim()
    if (
      !raw ||
      (stt.noSpeechProb !== undefined && stt.noSpeechProb > 0.85 && countWords(raw) <= 2)
    ) {
      return notice('Nothing heard')
    }

    // 3. Text
    const style = resolveStyle(s.formatting, app)
    const pipelineOpts = this.pipelineOptions(s, style)
    let final: PipelineResult
    let llmUsed = false
    let llmStatus: LlmStatus | undefined
    let pressEnter = false
    let replaceSelection = false
    let selectionRestore: (() => void) | null = null

    if (job.mode === 'command') {
      // Wait for the user to physically release the chord FIRST (hook still live so the key-ups
      // land), then suppress the hook and copy the selection so our Ctrl+C is not seen as input.
      await this.deps.hook.waitForKeysUp(1500)
      this.deps.hook.beginSynthetic()
      const sel = await readSelection().catch(() => ({ text: '', restore: () => undefined }))
      this.deps.hook.endSynthetic()
      selectionRestore = sel.restore
      if (!sel.text.trim()) {
        sel.restore()
        return failure(raw, resolved, 'Select some text first, then hold the command key')
      }
      t = performance.now()
      let llm: LlmConfig
      try {
        llm = (await this.deps.inference.llm()).cfg
      } catch (err) {
        sel.restore()
        return failure(raw, resolved, friendlyError(err))
      }
      if (!llm.baseUrl || !llm.model) {
        sel.restore()
        return failure(raw, resolved, 'Command mode needs a formatting model (Style settings)')
      }
      try {
        const res = await this.deps.inference.complete(
          llm,
          buildCommandMessages({
            selection: sel.text,
            instruction: raw,
            app,
            dictionary: s.dictionary,
            language: s.stt.language
          }),
          {
            maxTokens: Math.min(4096, Math.max(1024, countWords(sel.text) * 4 + 512))
          }
        )
        timings.llmMs = Math.round(performance.now() - t)
        const guard = sanitizeLlmOutput(res.text, sel.text)
        if (!guard.text) throw new SttError('The model returned nothing', 'unknown')
        final = {
          text: guard.text,
          pressEnter: false,
          wordCount: countWords(guard.text),
          snippetsExpanded: [],
          stages: ['command'],
          empty: false,
          hints: {
            list: { requested: null, explicit: false, markers: 0 },
            listApplied: false,
            isQuestion: false,
            hasLineBreaks: guard.text.includes('\n')
          }
        }
        llmUsed = true
        llmStatus = { outcome: 'used' }
        replaceSelection = true
      } catch (err) {
        timings.llmMs = Math.round(performance.now() - t)
        sel.restore()
        return failure(raw, resolved, friendlyError(err))
      }
    } else {
      t = performance.now()
      const light = runPipeline(raw, pipelineOpts)
      timings.formatMs = Math.round(performance.now() - t)
      final = light
      pressEnter = light.pressEnter
      // A formatting model that cannot be reached (signed out of Murmur, no token) is not an
      // error for the dictation: the rule-based text goes in, and History says why.
      let llm: LlmConfig = NO_LLM
      let llmUnavailable: string | undefined
      if (style.mode === 'smart') {
        try {
          llm = (await this.deps.inference.llm()).cfg
        } catch (err) {
          llmUnavailable = friendlyError(err)
        }
      }
      const smart = await smartFormat(
        {
          light,
          formatting: s.formatting,
          dictionary: s.dictionary,
          style,
          app,
          llm,
          pipelineOpts,
          language: s.stt.language
        },
        this.deps.inference.complete
      )
      timings.llmMs = smart.llmMs
      llmStatus =
        llmUnavailable && smart.status.outcome === 'skipped'
          ? { outcome: 'skipped', detail: llmUnavailable }
          : smart.status
      final = smart.result
      final.pressEnter = pressEnter
      llmUsed = smart.status.outcome === 'used' || smart.status.outcome === 'partial'
      if (smart.status.outcome === 'rejected')
        log.warn(
          `LLM output rejected (${smart.status.detail}; finish=${smart.finishReason ?? '?'}); using deterministic text`
        )
      else if (smart.status.outcome === 'failed')
        log.warn(`LLM formatting failed, using deterministic text: ${smart.status.detail}`)
      else if (smart.status.outcome === 'partial')
        log.info(
          `LLM review reverted ${smart.status.reverted} of ${(smart.status.accepted ?? 0) + (smart.status.reverted ?? 0)} edits`
        )
      if (style.mode === 'off') {
        final = { ...light, text: raw + (style.trailingSpace ? ' ' : ''), stages: [] }
      }
    }

    if (final.empty || !final.text) {
      selectionRestore?.()
      return notice('Nothing to insert')
    }

    // 4. Inject (serialized), or only copy when the text has nowhere to go right now.
    t = performance.now()
    const injectResult = job.inject
      ? await this.enqueueInject(final.text, pressEnter, s, replaceSelection)
      : await this.enqueueInject(final.text, false, s, false, 'clipboard')
    timings.injectMs = Math.round(performance.now() - t)
    timings.totalMs = Math.round(performance.now() - stopAt)
    if (selectionRestore)
      setTimeout(selectionRestore, Math.max(300, s.injection.restoreClipboardDelayMs))

    // The audio stays with a successful dictation only if the user wants recordings kept.
    const recording = s.audio.keepRecordings ? job.recording : undefined
    if (job.recording && !recording) this.deps.recordings.delete(job.recording)
    const entry: HistoryEntry = {
      id: job.id,
      createdAt: job.previous?.createdAt ?? Date.now(),
      mode: job.mode,
      rawText: raw,
      finalText: final.text.trimEnd(),
      wordCount: final.wordCount,
      speechMs: timings.recordMs,
      appName: windowInfo.app || windowInfo.title || undefined,
      provider: resolved.provider,
      model: resolved.cfg.model,
      injected: injectResult.ok && injectResult.method !== 'clipboard',
      injectionMethod: injectResult.method,
      llmUsed,
      llm: llmStatus,
      stages: stt.resumed ? ['stt-resumed', ...final.stages] : final.stages,
      timings,
      error: injectResult.ok ? undefined : injectResult.error,
      recording,
      attempts: job.attempts > 1 ? job.attempts : undefined
    }
    if (job.previous) this.deps.history.replace(entry)
    else this.deps.history.add(entry)
    this.updateStats(entry)
    log.info(
      `session ${job.id.slice(0, 8)} done: ${final.wordCount} words, stt=${timings.sttMs}ms llm=${timings.llmMs}ms inject=${timings.injectMs}ms total=${timings.totalMs}ms via ${injectResult.method}${llmUsed ? ' (smart)' : ''}${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}`
    )
    if (injectResult.ok) {
      this.deps.overlay.setState({
        phase: 'success',
        message: !job.inject
          ? 'Transcribed — copied to clipboard'
          : injectResult.method === 'clipboard'
            ? 'Copied — press Ctrl+V'
            : undefined
      })
    } else {
      this.showError(`Copied to clipboard. ${injectResult.error ?? 'Could not insert text'}`)
    }
    this.emit('entry', entry)
    return { ok: true, entry }
  }

  /**
   * One transcription request with the two recoveries that make sense for it: a Murmur session
   * token the gateway no longer accepts is refreshed once (`resolved.cfg` is updated so the next
   * resume round uses it too), and a user's own model that errors falls back to their fallback model.
   */
  private async transcribeWithFallback(
    wav: Uint8Array,
    prompt: string | undefined,
    keyterms: string[],
    resolved: ResolvedStt
  ): Promise<TranscribeOutput> {
    const cfg = resolved.cfg
    const provider = getSttProvider(cfg.kind)
    try {
      return await provider.transcribe({ wav, prompt, keyterms }, cfg)
    } catch (err) {
      const refreshed = await this.deps.inference.refreshedStt(resolved, err)
      if (refreshed) {
        resolved.cfg = refreshed
        return provider.transcribe({ wav, prompt, keyterms }, refreshed)
      }
      const e = err instanceof SttError ? err : null
      const fallbackModel = resolved.fallbackModel
      if (e?.retryable && fallbackModel && fallbackModel !== cfg.model) {
        log.warn(
          `STT ${cfg.model} failed (${e.kind}: ${e.message}); retrying with ${fallbackModel}`
        )
        return provider.transcribe({ wav, prompt, keyterms }, { ...cfg, model: fallbackModel })
      }
      throw err
    }
  }

  private enqueueInject(
    text: string,
    pressEnter: boolean,
    s: Settings,
    replaceSelection: boolean,
    forceMethod?: 'clipboard'
  ): Promise<InjectResult> {
    const run = async (): Promise<InjectResult> => {
      await this.deps.hook.waitForKeysUp(1500)
      this.deps.hook.beginSynthetic()
      try {
        // Replacing a selection through the clipboard is unreliable when we own the X CLIPBOARD
        // (GTK paste can fail to consume the selection), so type over it directly.
        const method =
          forceMethod ??
          (replaceSelection && process.platform !== 'win32' ? 'type' : s.injection.method)
        return await injectText(text, {
          method,
          restoreClipboard: s.injection.restoreClipboard,
          restoreClipboardDelayMs: s.injection.restoreClipboardDelayMs,
          typeChunkSize: s.injection.typeChunkSize,
          typeChunkDelayMs: s.injection.typeChunkDelayMs,
          pressEnter,
          waitForKeysUp: () => this.deps.hook.waitForKeysUp(1500)
        })
      } finally {
        // Keep suppressing briefly so the trailing synthesized key-ups are ignored too.
        this.deps.hook.endSynthetic(200)
      }
    }
    const result = this.injectQueue.then(run, run)
    this.injectQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Rule-based options for a destination; `style` carries the per-app and category overrides. */
  pipelineOptions(s: Settings, style?: ResolvedStyle): PipelineOptions {
    const f = s.formatting
    return {
      removeFillers: f.removeFillers,
      fillerWords: f.fillerWords,
      hesitations: f.hesitations,
      hesitationPhrases: f.hesitationPhrases,
      collapseRepeats: f.collapseRepeats,
      repetitionScope: f.repetitionScope,
      spokenCommands: f.spokenCommands,
      selfCorrections: f.selfCorrections,
      autoCapitalize: f.autoCapitalize,
      trailingSpace: style?.trailingSpace ?? f.trailingSpace,
      pressEnterCommand: f.pressEnterCommand,
      lists: style?.lists ?? f.lists,
      listStyle: f.listStyle,
      bulletMarker: f.bulletMarker,
      numbers: style?.numbers ?? f.numbers,
      dictionary: s.dictionary,
      snippets: s.snippets,
      snippetContext: { now: new Date() }
    }
  }

  /**
   * A dictation that produced nothing still shows up in History with what went wrong and, when the
   * audio was stored, can be sent again from there. A retry that fails again replaces the entry.
   */
  private recordFailure(
    job: ProcessJob,
    raw: string,
    app: AppContext,
    timings: StageTimings,
    resolved: ResolvedStt | null,
    error: string
  ): void {
    const s = this.deps.settings.get()
    const entry: HistoryEntry = {
      id: job.id,
      createdAt: job.previous?.createdAt ?? Date.now(),
      mode: job.mode,
      rawText: raw || job.previous?.rawText || '',
      finalText: '',
      wordCount: 0,
      speechMs: timings.recordMs,
      appName: app.app || job.previous?.appName || undefined,
      provider: resolved?.provider ?? s.stt.kind,
      model: resolved?.cfg.model ?? s.stt.model,
      injected: false,
      llmUsed: false,
      timings,
      error,
      recording: job.recording,
      attempts: job.attempts > 1 ? job.attempts : undefined
    }
    if (job.previous) this.deps.history.replace(entry)
    else this.deps.history.add(entry)
  }

  private updateStats(entry: HistoryEntry): void {
    const s = this.deps.settings.get()
    const today = localDay(new Date(entry.createdAt))
    const yesterday = localDay(new Date(entry.createdAt - 86400000))
    let streak = s.stats.streakDays
    if (s.stats.lastSessionDay !== today)
      streak = s.stats.lastSessionDay === yesterday ? streak + 1 : 1
    this.deps.settings.patch({
      stats: {
        totalWords: s.stats.totalWords + entry.wordCount,
        totalSessions: s.stats.totalSessions + 1,
        totalSpeechMs: s.stats.totalSpeechMs + entry.speechMs,
        streakDays: streak,
        lastSessionDay: today
      }
    })
  }

  private showNotice(message: string): void {
    this.deps.overlay.setState({ phase: 'error', message })
  }

  /** `retryId`: the failed dictation's audio is stored, so the pill offers to send it again. */
  private showError(message: string, retryId?: string): void {
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('error')
    this.deps.overlay.setState({ phase: 'error', message, retryId })
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof SttError) {
    // The Murmur gateway (and the router in front of it) already speak to the user.
    if (err.code && MURMUR_ERROR_CODES.has(err.code)) return err.message
    switch (err.kind) {
      case 'auth':
        return 'Authentication failed — check your API key'
      case 'model':
        return err.suggestedModels.length
          ? `Model not available. Try: ${err.suggestedModels.slice(0, 3).join(', ')}`
          : `Model not available: ${err.message}`
      case 'rate-limit':
        return 'Rate limited by the provider — try again in a moment'
      case 'network':
        return err.message
      case 'timeout':
        return 'The server took too long to respond'
      case 'server':
        return `Provider error: ${err.message}`
      default:
        return err.message
    }
  }
  if (err instanceof Error) return err.message
  return String(err)
}
