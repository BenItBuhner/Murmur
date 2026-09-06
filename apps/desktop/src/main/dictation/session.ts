import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HotkeyAction } from '@core/hotkey/engine'
import { adaptiveThreshold, analyze, trimSilence } from '@core/audio/vad'
import { encodeWavPcm16 } from '@core/audio/wav'
import { getSttProvider, SttError, type SttConfig, type TranscribeOutput } from '@core/stt'
import { chatComplete } from '@core/llm/client'
import { buildSttPrompt } from '@core/text/dictionary'
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
import type { Settings } from '@shared/settings'
import type {
  ActiveWindowInfo,
  DictationMode,
  HistoryEntry,
  LlmStatus,
  OverlayState,
  StageTimings
} from '@shared/types'
import type { SoundName } from '@shared/ipc'
import { createLogger } from '../logger'
import { localDay } from '../cloud/reducers'
import type { Recorder } from '../audio/recorder'
import type { HookService } from '../hotkeys/hook'
import type { SettingsStore } from '../store/settings'
import type { HistoryStore } from '../store/history'
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

export interface SessionDeps {
  settings: SettingsStore
  history: HistoryStore
  recorder: Recorder
  hook: HookService
  overlay: { setState: (s: OverlayState) => void; playSound: (n: SoundName) => void }
  getActiveWindow: () => Promise<ActiveWindowInfo>
}

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
    session.maxTimer = setTimeout(() => {
      if (this.active === session) {
        log.info('max duration reached; stopping')
        this.deps.hook.notifySessionEnded()
        void this.stop()
      }
    }, s.audio.maxDurationSec * 1000)
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
    try {
      const pcm = await this.deps.recorder.stop(session.id)
      await this.process(session, pcm, stopAt, s)
    } catch (err) {
      log.error('session processing crashed', err)
      this.showError(friendlyError(err))
    } finally {
      this.processing--
      if (!this.active && this.processing === 0) this.emit('state', 'idle')
    }
  }

  private clearTimers(session: ActiveSession): void {
    if (session.elapsedTimer) clearInterval(session.elapsedTimer)
    if (session.maxTimer) clearTimeout(session.maxTimer)
    session.elapsedTimer = null
    session.maxTimer = null
  }

  // ---- pipeline -----------------------------------------------------------------------------

  private async process(
    session: ActiveSession,
    pcm: Int16Array,
    stopAt: number,
    s: Settings
  ): Promise<void> {
    const timings: StageTimings = {
      recordMs: Math.round((pcm.length / SAMPLE_RATE) * 1000),
      vadMs: 0,
      sttMs: 0,
      formatMs: 0,
      llmMs: 0,
      injectMs: 0,
      totalMs: 0
    }
    const windowInfo = await session.windowInfo
    const app: AppContext = classifyApp(windowInfo.app, windowInfo.title)

    // 1. VAD
    let t = performance.now()
    let audio = pcm
    if (pcm.length < SAMPLE_RATE * 0.15) {
      this.showNotice('Too short')
      return
    }
    const threshold = adaptiveThreshold(pcm, SAMPLE_RATE, s.audio.silenceThresholdDb)
    const analysis = analyze(pcm, { sampleRate: SAMPLE_RATE, thresholdDb: threshold })
    if (s.audio.skipIfSilent && !analysis.hasSpeech) {
      timings.vadMs = Math.round(performance.now() - t)
      log.info(
        `session ${session.id.slice(0, 8)}: no speech (peak ${analysis.peakDb.toFixed(1)} dB, threshold ${threshold.toFixed(1)} dB)`
      )
      this.showNotice('No speech detected')
      return
    }
    if (s.audio.trimSilence)
      audio = trimSilence(pcm, {
        sampleRate: SAMPLE_RATE,
        thresholdDb: threshold,
        paddingMs: 300
      }).pcm
    timings.vadMs = Math.round(performance.now() - t)
    const wav = encodeWavPcm16(audio, SAMPLE_RATE)

    // 2. STT
    t = performance.now()
    const sttCfg: SttConfig = {
      kind: s.stt.kind,
      baseUrl: s.stt.baseUrl,
      apiKey: this.deps.settings.getSecret('stt'),
      model: s.stt.model,
      language: s.stt.language,
      timeoutMs: s.stt.timeoutMs
    }
    const prompt = s.stt.useDictionaryPrompt
      ? buildSttPrompt(
          s.dictionary,
          s.snippets.map((x) => x.trigger)
        )
      : undefined
    const keyterms = s.dictionary.map((d) => d.word)
    let stt: TranscribeOutput
    try {
      stt = await this.transcribeWithFallback(wav, prompt, keyterms, sttCfg, s.stt.fallbackModel)
    } catch (err) {
      timings.sttMs = Math.round(performance.now() - t)
      this.recordFailure(session, '', app, timings, sttCfg, friendlyError(err))
      this.showError(friendlyError(err))
      return
    }
    timings.sttMs = Math.round(performance.now() - t)
    const raw = stt.text.trim()
    if (
      !raw ||
      (stt.noSpeechProb !== undefined && stt.noSpeechProb > 0.85 && countWords(raw) <= 2)
    ) {
      this.showNotice('Nothing heard')
      return
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

    if (session.mode === 'command') {
      // Wait for the user to physically release the chord FIRST (hook still live so the key-ups
      // land), then suppress the hook and copy the selection so our Ctrl+C is not seen as input.
      await this.deps.hook.waitForKeysUp(1500)
      this.deps.hook.beginSynthetic()
      const sel = await readSelection().catch(() => ({ text: '', restore: () => undefined }))
      this.deps.hook.endSynthetic()
      selectionRestore = sel.restore
      if (!sel.text.trim()) {
        this.showError('Select some text first, then hold the command key')
        sel.restore()
        return
      }
      t = performance.now()
      const llm = this.deps.settings.llmConnection()
      if (!llm.baseUrl || !llm.model) {
        this.showError('Command mode needs a formatting model (Style settings)')
        sel.restore()
        return
      }
      try {
        const res = await chatComplete(
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
        this.recordFailure(session, raw, app, timings, sttCfg, friendlyError(err))
        this.showError(friendlyError(err))
        sel.restore()
        return
      }
    } else {
      t = performance.now()
      const light = runPipeline(raw, pipelineOpts)
      timings.formatMs = Math.round(performance.now() - t)
      final = light
      pressEnter = light.pressEnter
      const smart = await smartFormat({
        light,
        formatting: s.formatting,
        dictionary: s.dictionary,
        style,
        app,
        llm: this.deps.settings.llmConnection(),
        pipelineOpts,
        language: s.stt.language
      })
      timings.llmMs = smart.llmMs
      llmStatus = smart.status
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
      this.showNotice('Nothing to insert')
      selectionRestore?.()
      return
    }

    // 4. Inject (serialized)
    t = performance.now()
    const injectResult = await this.enqueueInject(final.text, pressEnter, s, replaceSelection)
    timings.injectMs = Math.round(performance.now() - t)
    timings.totalMs = Math.round(performance.now() - stopAt)
    if (selectionRestore)
      setTimeout(selectionRestore, Math.max(300, s.injection.restoreClipboardDelayMs))

    const entry: HistoryEntry = {
      id: session.id,
      createdAt: Date.now(),
      mode: session.mode,
      rawText: raw,
      finalText: final.text.trimEnd(),
      wordCount: final.wordCount,
      speechMs: timings.recordMs,
      appName: windowInfo.app || windowInfo.title || undefined,
      provider: s.stt.kind,
      model: s.stt.model,
      injected: injectResult.ok && injectResult.method !== 'clipboard',
      injectionMethod: injectResult.method,
      llmUsed,
      llm: llmStatus,
      stages: final.stages,
      timings,
      error: injectResult.ok ? undefined : injectResult.error
    }
    this.deps.history.add(entry)
    this.updateStats(entry)
    log.info(
      `session ${session.id.slice(0, 8)} done: ${final.wordCount} words, stt=${timings.sttMs}ms llm=${timings.llmMs}ms inject=${timings.injectMs}ms total=${timings.totalMs}ms via ${injectResult.method}${llmUsed ? ' (smart)' : ''}`
    )
    if (injectResult.ok) {
      this.deps.overlay.setState({
        phase: 'success',
        message: injectResult.method === 'clipboard' ? 'Copied — press Ctrl+V' : undefined
      })
    } else {
      this.showError(`Copied to clipboard. ${injectResult.error ?? 'Could not insert text'}`)
    }
    this.emit('entry', entry)
  }

  private async transcribeWithFallback(
    wav: Uint8Array,
    prompt: string | undefined,
    keyterms: string[],
    cfg: SttConfig,
    fallbackModel: string
  ): Promise<TranscribeOutput> {
    const provider = getSttProvider(cfg.kind)
    try {
      return await provider.transcribe({ wav, prompt, keyterms }, cfg)
    } catch (err) {
      const e = err instanceof SttError ? err : null
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
    replaceSelection: boolean
  ): Promise<InjectResult> {
    const run = async (): Promise<InjectResult> => {
      await this.deps.hook.waitForKeysUp(1500)
      this.deps.hook.beginSynthetic()
      try {
        // Replacing a selection through the clipboard is unreliable when we own the X CLIPBOARD
        // (GTK paste can fail to consume the selection), so type over it directly.
        const method =
          replaceSelection && process.platform !== 'win32' ? 'type' : s.injection.method
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

  private recordFailure(
    session: ActiveSession,
    raw: string,
    app: AppContext,
    timings: StageTimings,
    cfg: SttConfig,
    error: string
  ): void {
    this.deps.history.add({
      id: session.id,
      createdAt: Date.now(),
      mode: session.mode,
      rawText: raw,
      finalText: '',
      wordCount: 0,
      speechMs: timings.recordMs,
      appName: app.app || undefined,
      provider: cfg.kind,
      model: cfg.model,
      injected: false,
      llmUsed: false,
      timings,
      error
    })
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

  private showError(message: string): void {
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('error')
    this.deps.overlay.setState({ phase: 'error', message })
  }
}

export function friendlyError(err: unknown): string {
  if (err instanceof SttError) {
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
