import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HotkeyAction } from '@core/hotkey/engine'
import { adaptiveThreshold, analyze, trimSilence } from '@core/audio/vad'
import {
  getSttProvider,
  SttError,
  transcribeComplete,
  type CompleteResult,
  type InferenceTier,
  type TranscribeOutput
} from '@core/stt'
import type { LlmConfig } from '@core/llm/client'
import {
  STT_BASE_PROMPT,
  buildCommandMessages,
  buildSttPrompt,
  classifyApp,
  cleanModelOutput,
  countWords,
  finish,
  formatTranscript,
  resolveStyle,
  type AppContext,
  type FormatContext,
  type FormatInput,
  type ResolvedStyle,
  isSilenceHallucination,
  joinPieces,
  joinSeam,
  lastSentenceStart,
  seamContext,
  stripEcho
} from '@engine'
import {
  FAST_SKIP_DETAIL,
  MURMUR_ERROR_CODES,
  effectiveSpeed,
  formattingModeAt,
  type ServiceNotice,
  type SpeedOutcome
} from '@shared/inference'
import { isPlanLimit, type LimitNotice } from '@shared/limits'
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
import { DEFAULT_CHUNK_PLAN } from '@core/audio/chunker'
import { ChunkStreamer, type TailSpeculation } from './streaming'
import { dictateRelease, prewarmGateway } from '@core/stt/openai-compatible'
import { encodeWavPcm16 } from '@core/audio/wav'
import { MURMUR_PROVIDER } from '@shared/inference'
import type { HookService } from '../hotkeys/hook'
import type { FormatOutcome, Formatter, InferenceRouter, ResolvedStt } from '../inference/router'
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
  /** The stand-in clip (MURMUR_TEST_AUDIO_FILE) is spent; a microphone never says so. */
  inputEnded: boolean
  /** Long dictations to Murmur's gateway go up in pieces while they are spoken. */
  stream?: ChunkStreamer<TailSpec>
  streamFormats?: Promise<FormatOutcome | 'empty' | null>[]
  streamListener?: (id: string, samples: number) => void
}

/** The unfinished stretch after the last piece, transcribed and formatted up to a pause. */
interface TailSpec {
  text: string
  format: Promise<FormatOutcome | 'empty' | null>
}

/** What was already transcribed while the user spoke: the samples covered and their texts. */
interface StreamedPrefix {
  samples: number
  texts: Promise<string[]>
  /** A speculation on the stretch after the pieces; the rest of the audio starts at its samples. */
  spec?: TailSpeculation<TailSpec>
  /**
   * Each piece formatted on the gateway as soon as its text arrived (precision mode only), in
   * order: 'empty' for a piece with no speech, null where speculation was not possible.
   */
  formats: Promise<FormatOutcome | 'empty' | null>[]
}

/** Streamed pieces and the tail, for formatting the tail alone at release. */
type StreamedStt = CompleteResult & {
  streamed?: { texts: string[]; tail: string; spec?: TailSpec }
}

/** What the formatter is told about a piece of a longer dictation. */
const PIECE_NOTE =
  'This transcript is one part of a longer dictation and may stop mid-sentence; if it does, leave the end unpunctuated.'

/**
 * Context for formatting one piece of a streamed dictation: the piece before it stands in for the
 * text before the cursor (when the platform gave none, or after it), and a piece that is not the
 * last may stop mid-sentence.
 */
function pieceContext(ctx: FormatContext, before: string, last = false): FormatContext {
  const prior = seamContext(before)
  return {
    ...ctx,
    precedingText: prior ? `${ctx.precedingText ?? ''} ${prior}`.trim() : ctx.precedingText,
    instructions: last
      ? ctx.instructions
      : [ctx.instructions?.trim(), PIECE_NOTE].filter(Boolean).join(' ')
  }
}

/** Pieces formatted separately, joined in order with their seams repaired; the last decides Enter. */
function joinFormatted(parts: FormatOutcome[]): FormatOutcome {
  const rank: Record<string, number> = {
    used: 0,
    'skipped-clean': 1,
    skipped: 2,
    rejected: 3,
    failed: 4
  }
  const worst = parts.reduce((a, b) =>
    (rank[b.status.outcome] ?? 0) > (rank[a.status.outcome] ?? 0) ? b : a
  )
  const stages: string[] = []
  for (const p of parts) for (const st of p.stages) if (!stages.includes(st)) stages.push(st)
  return {
    text: joinPieces(parts.map((p) => p.text)).text,
    pressEnter: parts[parts.length - 1].pressEnter,
    modelText: parts.every((p) => p.modelText !== undefined)
      ? joinPieces(parts.map((p) => p.modelText!)).text
      : undefined,
    llmMs: parts[parts.length - 1].llmMs,
    status:
      worst.status.outcome === 'used'
        ? { ...worst.status, detail: `${parts.length} pieces, formatted while speaking` }
        : worst.status,
    stages,
    limit: parts.find((p) => p.limit)?.limit
  }
}

/** One run of the pipeline: a dictation that was just spoken, or a stored one sent again. */
interface ProcessJob {
  id: string
  /** The release passed its deadline and the user was offered Retry: a late answer is dropped. */
  abandoned?: boolean
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

/** Voiced time below which a tail that reads as a stock phrase is taken for silence. */
const TAIL_PHRASE_MIN_SPEECH_MS = 600

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
    // A clip standing in for the microphone (MURMUR_TEST_AUDIO_FILE) says when it is spent.
    this.deps.recorder.on('ended', (id: string) => this.onInputEnded(id))
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
      maxTimer: null,
      inputEnded: false
    }
    this.active = session
    // Audio first: every millisecond before capture starts is a clipped first word.
    this.deps.recorder.start(id, mode !== 'command' && s.audio.preBufferMs > 0)
    if (mode !== 'command' && process.env.MURMUR_NO_STREAMING !== '1')
      this.startStreaming(session, s)
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
    if (this.active.inputEnded) {
      // Locking a session whose stand-in microphone is already spent: nothing left to wait for.
      this.deps.hook.notifySessionEnded()
      void this.stop()
      return
    }
    this.deps.overlay.setState({
      phase: 'listening',
      mode: 'hands-free',
      locked: true,
      elapsedSec: Math.round((performance.now() - this.active.startedAt) / 1000)
    })
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('lock')
  }

  /**
   * The audio source ran dry; a microphone never does, a fixture clip does. A held key keeps the
   * session open until it is released, as with a microphone in a room gone quiet; a hands-free
   * session has nothing left to wait for and stops as if the user had stopped it.
   */
  private onInputEnded(id: string): void {
    const session = this.active
    if (!session || session.id !== id) return
    session.inputEnded = true
    if (!session.locked) return
    log.info(`session ${id.slice(0, 8)}: fixture audio finished; stopping the hands-free session`)
    this.deps.hook.notifySessionEnded()
    void this.stop()
  }

  private cancel(): void {
    const session = this.active
    if (!session) return
    this.clearTimers(session)
    this.active = null
    this.stopStreaming(session)
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
      const streamed = this.stopStreaming(session)
      // Store the audio before anything can go wrong with it: a failed request is retried from
      // this file, and a kept recording is what History plays back.
      job.recording = await this.storeRecording(session.id, pcm)
      // A hard deadline: whatever stalls, the pill never sits on "processing" forever.
      const audioSec = pcm.length / SAMPLE_RATE
      const work = this.process(job, pcm, stopAt, s, streamed)
      const done = await within(work, releaseDeadlineMs(audioSec)).then(
        () => true,
        (err: unknown) => {
          if (err instanceof ReleaseTimeoutError) return false
          throw err
        }
      )
      if (!done) {
        job.abandoned = true
        work.catch(() => undefined)
        log.warn(`session ${job.id.slice(0, 8)}: release passed its ${releaseDeadlineMs(audioSec)} ms deadline; offering Retry`)
        const timings: StageTimings = {
          recordMs: Math.round(audioSec * 1000),
          vadMs: 0,
          sttMs: 0,
          formatMs: 0,
          llmMs: 0,
          injectMs: 0,
          totalMs: Math.round(performance.now() - stopAt)
        }
        this.recordFailure(job, '', classifyApp('', ''), timings, null, RELEASE_TIMEOUT_MESSAGE)
        this.showError(RELEASE_TIMEOUT_MESSAGE, job.recording ? job.id : undefined)
      }
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

  /**
   * Transcribe finished 18-30 s stretches while the user keeps talking, so release only waits
   * for the last stretch. Murmur's gateway only: a piece for any other provider fails before a
   * request is made, and the dictation is then transcribed whole as before.
   */
  private startStreaming(session: ActiveSession, s: Settings): void {
    const recorder = this.deps.recorder as Partial<Recorder>
    if (typeof recorder.read !== 'function' || typeof recorder.removeListener !== 'function') return
    const tag = session.id.slice(0, 8)
    let target: Promise<{
      resolved: ResolvedStt
      prompt?: string
      keyterms: string[]
      smart: boolean
      context: FormatContext
    }> | null = null
    const formats: Promise<FormatOutcome | 'empty' | null>[] = []
    session.streamFormats = formats
    const resolveTarget = (): typeof target =>
      (target ??= (async () => {
        const w = await session.windowInfo
        const style = resolveStyle(s.formatting, s.formatting.appRules, classifyApp(w.app, w.title))
        const resolved = await this.deps.inference.stt({
          speed: effectiveSpeed(s.stt.speed, style.rule)
        })
        if (resolved.provider !== MURMUR_PROVIDER) throw new Error('streaming is for Murmur only')
        // Open the connection to Murmur's gateway now, so the release does not pay for it.
        if (resolved.source === 'murmur') void prewarmGateway(resolved.cfg.baseUrl, resolved.cfg.apiKey).catch(() => undefined)
        const app = classifyApp(w.app, w.title)
        const speed = effectiveSpeed(s.stt.speed, style.rule)
        const smart = formattingModeAt(style.mode, speed) === 'smart'
        const context = this.formatContext(s, style, app)
        const prompt = s.stt.useDictionaryPrompt
          ? buildSttPrompt(
              s.dictionary,
              s.snippets.map((x) => x.trigger)
            )
          : undefined
        return { resolved, prompt, keyterms: s.dictionary.map((d) => d.word), smart, context }
      })())
    const pieceTexts: Promise<string>[] = []
    const transcribePiece = async (pcm: Int16Array, index: number): Promise<string> => {
      // Registered before the first await, so the session sees every piece's slot at release.
      let settle: (v: Promise<FormatOutcome | 'empty' | null> | 'empty' | null) => void = () =>
        undefined
      formats[index] = new Promise((r) => (settle = r))
      const own = transcribeOnly(pcm, index)
      own.catch(() => undefined)
      pieceTexts[index] = own
      try {
        const text = await own
        // The piece continues the one before it: the formatter sees that text as what precedes
        // the cursor, so a sentence the cut split is not capitalized or closed as if complete.
        const before = index > 0 ? await pieceTexts[index - 1].catch(() => '') : ''
        settle(
          text ? this.speculateFormat(text, await resolveTarget()!, tag, index, before) : 'empty'
        )
        return text
      } catch (err) {
        settle(null)
        throw err
      }
    }
    const transcribeOnly = async (pcm: Int16Array, index: number): Promise<string> => {
      const t = (await resolveTarget())!
      const threshold = adaptiveThreshold(pcm, SAMPLE_RATE, s.audio.silenceThresholdDb)
      const a = analyze(pcm, { sampleRate: SAMPLE_RATE, thresholdDb: threshold })
      if (!a.hasSpeech) return ''
      const started = performance.now()
      const out = await transcribeComplete(
        (wav, p) => this.transcribeWithFallback(wav, p, t.keyterms, t.resolved, 'background'),
        {
          pcm,
          sampleRate: SAMPLE_RATE,
          speechEndSec: a.lastVoicedMs / 1000,
          thresholdDb: threshold,
          prompt: t.prompt,
          tailPrompt: t.prompt ? STT_BASE_PROMPT : undefined,
          log: (m) => log.warn(`session ${tag} piece ${index}: ${m}`)
        }
      )
      log.info(
        `session ${tag}: piece ${index} (${(pcm.length / SAMPLE_RATE).toFixed(1)} s) transcribed in ${Math.round(performance.now() - started)} ms while recording`
      )
      return out.text.trim()
    }
    // The stretch after the last piece, up to its latest pause, so release only waits for the
    // words after that pause.
    const speculateTail = async (pcm: Int16Array): Promise<TailSpec> => {
      const n = pieceTexts.length
      const text = await transcribeOnly(pcm, n)
      const before = n > 0 ? await pieceTexts[n - 1].catch(() => '') : ''
      const format: Promise<FormatOutcome | 'empty' | null> = text
        ? this.speculateFormat(text, (await resolveTarget())!, tag, n, before)
        : Promise.resolve('empty')
      format.catch(() => undefined)
      return { text, format }
    }
    session.stream = new ChunkStreamer<TailSpec>(
      (from) => this.deps.recorder.read(session.id, from),
      transcribePiece,
      SAMPLE_RATE,
      s.audio.silenceThresholdDb,
      DEFAULT_CHUNK_PLAN,
      // MURMUR_TAIL_SPECULATION=0 turns it off (diagnostics, and tests of the plain pipeline).
      process.env.MURMUR_TAIL_SPECULATION === '0' ? undefined : speculateTail
    )
    session.streamListener = (id, samples) => {
      if (id === session.id) session.stream?.onSamples(samples)
    }
    this.deps.recorder.on('chunk', session.streamListener)
  }

  /**
   * Precision mode: format a piece on the gateway while the user keeps talking, with the same
   * engine and context the whole dictation would get. Null (format the whole text at release, as
   * before) when the mode skips the model, the formatter is not Murmur's, or the call fails.
   */
  private async speculateFormat(
    text: string,
    t: { smart: boolean; context: FormatContext },
    tag: string,
    index: number,
    before = ''
  ): Promise<FormatOutcome | null> {
    if (!t.smart) return null
    try {
      const formatter = await this.deps.inference.formatter()
      if (formatter.source !== 'murmur') return null
      const started = performance.now()
      const out = await formatter.format(
        {
          transcript: text,
          mode: 'smart',
          context: pieceContext(t.context, before)
        },
        { tier: 'background' }
      )
      log.info(
        `session ${tag}: piece ${index} formatted in ${Math.round(performance.now() - started)} ms while recording`
      )
      if (out.status.outcome === 'failed') return null
      return { ...out, text: stripEcho(out.text, seamContext(before)) }
    } catch {
      return null
    }
  }

  private stopStreaming(session: ActiveSession): StreamedPrefix | undefined {
    if (session.streamListener) this.deps.recorder.removeListener('chunk', session.streamListener)
    session.streamListener = undefined
    const stream = session.stream
    session.stream = undefined
    const formats = session.streamFormats ?? []
    session.streamFormats = undefined
    const spec = stream?.speculation() ?? undefined
    if (!stream || (stream.piecesSent === 0 && !spec)) return undefined
    for (const f of formats) f.catch(() => undefined)
    return { ...stream.finish(), formats, spec }
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
    s: Settings,
    streamed?: StreamedPrefix
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
    // A refusal on a plan limit is still a failure the recording survives: the entry and the pill
    // carry the limit so the user learns what ran out, when it comes back, and what else they can
    // do, with Retry right there for when it has. A Murmur provider that is down is explained the
    // same calm way, with Retry for when it is back.
    const failure = (raw: string, resolved: ResolvedStt | null, err: unknown): ProcessOutcome => {
      const error = friendlyError(err)
      const limit = planLimitOf(err)
      const service = serviceNoticeOf(err)
      log.warn(
        `session ${job.id.slice(0, 8)} failed${limit ? ` on plan limit ${limit.limit}` : ''}${service ? ` (Murmur ${service.service} service unavailable: ${service.reason})` : ''}: ${error}`
      )
      this.recordFailure(job, raw, app, timings, resolved, error)
      this.showError(error, job.recording ? job.id : undefined, limit, service)
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

    // The destination's style is settled before the speech request: a per-app rule may pick the
    // speed, which the speech model is asked for and which decides whether the formatting model runs.
    const style = resolveStyle(s.formatting, s.formatting.appRules, app)
    const speed = effectiveSpeed(s.stt.speed, style.rule)

    // 2. STT
    t = performance.now()
    const tag = job.id.slice(0, 8)
    let resolved: ResolvedStt
    try {
      resolved = await this.deps.inference.stt({ speed })
    } catch (err) {
      timings.sttMs = Math.round(performance.now() - t)
      return failure('', null, err)
    }
    const prompt = s.stt.useDictionaryPrompt
      ? buildSttPrompt(
          s.dictionary,
          s.snippets.map((x) => x.trigger)
        )
      : undefined
    const keyterms = s.dictionary.map((d) => d.word)
    let stt: StreamedStt
    // The tail formatted on the gateway in the same call as its speech: [text it formatted, result].
    let preformatted: [string, FormatOutcome] | undefined
    const smartRelease =
      job.mode !== 'command' &&
      style.mode !== 'off' &&
      formattingModeAt(style.mode, speed) === 'smart' &&
      this.deps.inference.routing?.().llm === 'murmur' &&
      resolved.source === 'murmur'
    const run = (clip: Int16Array, endSec: number): Promise<CompleteResult> =>
      transcribeComplete((wav, p) => this.transcribeWithFallback(wav, p, keyterms, resolved), {
        pcm: clip,
        sampleRate: SAMPLE_RATE,
        speechEndSec: endSec,
        thresholdDb: threshold,
        prompt,
        // Resumed tails keep the style hint but never the vocabulary: a prompt that ends with a
        // term the speaker says next is exactly what makes Whisper stop early.
        tailPrompt: prompt ? STT_BASE_PROMPT : undefined,
        log: (m) => log.warn(`session ${tag}: ${m}`)
      })
    try {
      // One call for the tail when the speculation before it is formatted already: speech, then
      // formatting of its last sentence + the tail, on the gateway.
      const runTail = async (clip: Int16Array, endSec: number): Promise<CompleteResult> => {
        const plan = smartRelease && streamed ? await releasePlan(streamed) : null
        if (plan) {
          try {
            const answer = await dictateRelease(
              { wav: encodeWavPcm16(clip, SAMPLE_RATE), prompt },
              resolved.cfg,
              plan.prefix,
              { ...plan.format, context: pieceContext(this.formatContext(s, style, app), plan.before, true) }
            )
            if (answer) {
              if (answer.format) preformatted = [answer.transcript, answer.format as FormatOutcome]
              log.info(`session ${tag}: tail in one call, ${answer.stt.latencyMs} ms${answer.rules ? ' (short tail, rules)' : ''}`)
              return {
                ...answer.stt,
                resumed: 0,
                recoveredSec: 0,
                coverage: { transcribedSec: null, missingSec: 0, truncated: false }
              } as CompleteResult
            }
          } catch (err) {
            log.warn(`session ${tag}: one-call release failed; using two calls`, err)
          }
        }
        return run(clip, endSec)
      }
      stt = streamed
        ? await this.withStreamedPrefix(streamed, pcm, threshold, runTail, tag, () =>
            run(audio, speechEndSec)
          )
        : await run(audio, speechEndSec)
    } catch (err) {
      timings.sttMs = Math.round(performance.now() - t)
      return failure('', resolved, err)
    }
    timings.sttMs = Math.round(performance.now() - t)
    if (stt.speed && stt.speed.used !== stt.speed.requested)
      log.info(
        `session ${tag}: asked for ${stt.speed.requested} speech, ${speedLogNote(stt.speed)}`
      )
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
      (stt.noSpeechProb !== undefined && stt.noSpeechProb > 0.85 && countWords(raw) <= 2) ||
      (analysis.speechMs < TAIL_PHRASE_MIN_SPEECH_MS && isSilenceHallucination(raw))
    ) {
      return notice('Nothing heard')
    }

    // 3. Text
    let finalText = ''
    let stages: string[] = []
    let llmUsed = false
    let llmStatus: LlmStatus | undefined
    let pressEnter = false
    let replaceSelection = false
    let selectionRestore: (() => void) | null = null
    /** The text goes in, but the formatting model was paused or refused on a plan limit. */
    let softLimit: LimitNotice | undefined

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
        return failure(raw, resolved, err)
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
            category: app.category,
            dictionary: s.dictionary,
            language: s.stt.language
          }),
          {
            maxTokens: Math.min(4096, Math.max(1024, countWords(sel.text) * 4 + 512))
          }
        )
        timings.llmMs = Math.round(performance.now() - t)
        const edited = cleanModelOutput(res.text, sel.text)
        if (!edited) throw new SttError('The model returned nothing', 'unknown')
        finalText = edited
        stages = ['command']
        llmUsed = true
        llmStatus = { outcome: 'used', attempts: 1 }
        replaceSelection = true
      } catch (err) {
        timings.llmMs = Math.round(performance.now() - t)
        sel.restore()
        return failure(raw, resolved, err)
      }
    } else if (style.mode === 'off') {
      finalText = raw + (style.trailingSpace ? ' ' : '')
    } else {
      t = performance.now()
      // Fast is the quick path: the speech model's text gets the rule-based Light cleanup and goes
      // in, the formatting model is never asked, and History says that is why.
      const mode = formattingModeAt(style.mode, speed)
      const input: FormatInput = {
        transcript: raw,
        mode,
        context: this.formatContext(s, style, app)
      }
      let formatted: FormatOutcome
      if (mode !== 'smart') {
        formatted = await formatTranscript(input, null)
        if (mode !== style.mode)
          formatted.status = { outcome: 'skipped', detail: FAST_SKIP_DETAIL, attempts: 0 }
      } else {
        // A formatting model that cannot be reached (signed out of Murmur, no token, gateway
        // down) or refused on a plan limit is not an error for the dictation: the rule-based text
        // goes in, and History says why. A Murmur instance past the fair-use cap answers with the
        // rule-based text itself and says which limit paused the model.
        try {
          const formatter = await this.deps.inference.formatter()
          formatted =
            (await this.formatWithSpeculation(
              formatter,
              input,
              streamed,
              preformatted,
              stt,
              job.id.slice(0, 8)
            )) ?? (await formatter.format(input))
          softLimit = formatted.limit
        } catch (err) {
          formatted = await formatTranscript(input, null)
          formatted.status = { outcome: 'failed', detail: friendlyError(err), attempts: 0 }
          softLimit = planLimitOf(err)
        }
      }
      const finished = finish(formatted.text, {
        category: app.category,
        dictionary: s.dictionary,
        trailingSpace: style.trailingSpace,
        snippets: s.snippets,
        snippetContext: { now: new Date() }
      })
      timings.llmMs = formatted.llmMs
      timings.formatMs = Math.max(0, Math.round(performance.now() - t) - formatted.llmMs)
      pressEnter = formatted.pressEnter
      finalText = finished.text
      stages = [...formatted.stages, ...finished.stages]
      llmStatus = formatted.status
      llmUsed = formatted.status.outcome === 'used'
      if (formatted.status.outcome === 'rejected')
        log.warn(
          `model output rejected after ${formatted.status.attempts} attempt(s) (${formatted.status.detail}); using rule-based text`
        )
      else if (formatted.status.outcome === 'failed')
        log.warn(`model formatting failed, using rule-based text: ${formatted.status.detail}`)
      else if (formatted.status.retriedAfter)
        log.info(
          `model answer used after a strict retry (first attempt: ${formatted.status.retriedAfter})`
        )
    }

    if (!finalText.trim()) {
      selectionRestore?.()
      return notice('Nothing to insert')
    }
    const wordCount = countWords(finalText)

    // 4. Inject (serialized), or only copy when the text has nowhere to go right now.
    if (job.abandoned) {
      log.warn(`session ${job.id.slice(0, 8)}: finished after its deadline; not inserting`)
      return { ok: false, error: RELEASE_TIMEOUT_MESSAGE, recorded: true }
    }
    t = performance.now()
    const injectResult = job.inject
      ? await this.enqueueInject(finalText, pressEnter, s, replaceSelection)
      : await this.enqueueInject(finalText, false, s, false, 'clipboard')
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
      finalText: finalText.trimEnd(),
      wordCount,
      speechMs: timings.recordMs,
      appName: windowInfo.app || windowInfo.title || undefined,
      provider: resolved.provider,
      model: resolved.cfg.model,
      speed,
      sttSpeed: stt.speed,
      injected: injectResult.ok && injectResult.method !== 'clipboard',
      injectionMethod: injectResult.method,
      llmUsed,
      llm: llmStatus,
      stages: stt.resumed ? ['stt-resumed', ...stages] : stages,
      timings,
      error: injectResult.ok ? undefined : injectResult.error,
      recording,
      attempts: job.attempts > 1 ? job.attempts : undefined
    }
    if (job.previous) this.deps.history.replace(entry)
    else this.deps.history.add(entry)
    this.updateStats(entry)
    log.info(
      `session ${job.id.slice(0, 8)} done: ${wordCount} words, stt=${timings.sttMs}ms llm=${timings.llmMs}ms inject=${timings.injectMs}ms total=${timings.totalMs}ms via ${injectResult.method}${llmUsed ? ' (smart)' : llmStatus?.outcome === 'skipped-clean' ? ' (clean, no model)' : llmStatus?.detail === FAST_SKIP_DETAIL ? ' (fast, no model)' : ''} speed=${stt.speed ? speedLogNote(stt.speed) : speed}${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}`
    )
    if (injectResult.ok) {
      this.deps.overlay.setState({
        phase: 'success',
        message: !job.inject
          ? 'Transcribed — copied to clipboard'
          : injectResult.method === 'clipboard'
            ? 'Copied — press Ctrl+V'
            : undefined,
        limit: softLimit
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
  /**
   * The rest of a streamed dictation: only the audio after the pieces is sent now, alongside
   * waiting for the pieces. If any piece failed, the whole clip is transcribed as before.
   */
  private async withStreamedPrefix(
    streamed: StreamedPrefix,
    pcm: Int16Array,
    threshold: number,
    run: (clip: Int16Array, endSec: number) => Promise<CompleteResult>,
    tag: string,
    whole: () => Promise<CompleteResult>
  ): Promise<StreamedStt> {
    const sendFrom = (
      from: number
    ): {
      rest: Int16Array
      a: ReturnType<typeof analyze>
      tail: Promise<CompleteResult | null>
    } => {
      const rest = pcm.subarray(Math.min(from, pcm.length))
      const a = analyze(rest, { sampleRate: SAMPLE_RATE, thresholdDb: threshold })
      let tail: Promise<CompleteResult | null> = Promise.resolve(null)
      if (a.hasSpeech) {
        const trimmed = trimSilence(rest, {
          sampleRate: SAMPLE_RATE,
          thresholdDb: threshold,
          paddingMs: 300
        })
        tail = run(trimmed.pcm, (a.lastVoicedMs - trimmed.trimmedStartMs) / 1000)
      }
      tail.catch(() => undefined)
      return { rest, a, tail }
    }
    // With a speculation, only the audio after its pause is sent now; if it failed, the whole
    // stretch after the pieces is sent as before.
    let sent = sendFrom(streamed.spec ? streamed.spec.samples : streamed.samples)
    let spec: TailSpec | undefined
    // Everything streamed shares one wait; past it the whole dictation goes up instead.
    const streamDeadline = Date.now() + STREAM_WAIT_MS
    const left = (): number => Math.max(1, streamDeadline - Date.now())
    if (streamed.spec) {
      try {
        spec = await within(streamed.spec.result, left())
      } catch (err) {
        log.warn(`session ${tag}: the tail speculation failed; sending the whole tail`, err)
        sent = sendFrom(streamed.samples)
      }
    }
    const { rest, a, tail } = sent
    let texts: string[]
    try {
      texts = await within(streamed.texts, left())
    } catch (err) {
      log.warn(`session ${tag}: a streamed piece failed; transcribing the whole dictation`, err)
      return whole()
    }
    let last: CompleteResult | null
    try {
      last = await within(tail, left() + 10_000)
    } catch (err) {
      log.warn(`session ${tag}: the tail did not come back in time; transcribing the whole dictation`, err)
      return whole()
    }
    // A quiet tail (a breath, the key release) can come back as a stock phrase like "Thank you."
    // that nobody said: with under 0.6 s of voiced audio it is dropped.
    if (last && a.speechMs < TAIL_PHRASE_MIN_SPEECH_MS && isSilenceHallucination(last.text)) {
      log.info(`session ${tag}: dropped a stock phrase from a quiet tail (${a.speechMs} ms voiced)`)
      last = { ...last, text: '' }
    }
    const seams = joinPieces([...texts, spec?.text ?? '', last?.text ?? ''])
    const text = seams.text
    log.info(
      `session ${tag}: ${texts.length} piece(s) sent while recording${spec ? ' + tail speculation' : ''}; ${(rest.length / SAMPLE_RATE).toFixed(1)} s sent at release; seams: ${seams.joined} joined, ${seams.deduped} word(s) deduped`
    )
    return {
      ...(last ?? { latencyMs: 0, resumed: 0, recoveredSec: 0 }),
      text,
      // The pieces carry their own timings; spans of the tail alone would mislead coverage checks.
      spans: undefined,
      coverage: last?.coverage ?? { transcribedSec: null, missingSec: 0, truncated: false },
      streamed: { texts, tail: last?.text?.trim() ?? '', spec }
    } as StreamedStt
  }

  /**
   * A streamed precision dictation whose pieces were all formatted while it was spoken: only the
   * tail is formatted now, and the parts are joined. Null to format the whole text as before.
   */
  private async formatWithSpeculation(
    formatter: Formatter,
    input: FormatInput,
    streamed: StreamedPrefix | undefined,
    preformatted: [string, FormatOutcome] | undefined,
    stt: StreamedStt,
    tag: string
  ): Promise<FormatOutcome | null> {
    if (!streamed || !stt.streamed || formatter.source !== 'murmur') return null
    if (streamed.formats.length !== stt.streamed.texts.length) return null
    const tail = stt.streamed.tail
    const lastPiece = stt.streamed.texts[stt.streamed.texts.length - 1] ?? ''
    // A tail speculation already formatted: its last sentence is formatted again with the words
    // that followed, so the model sees that sentence whole; the rest of it stands.
    let specHead: FormatOutcome | null = null
    let tailInput = tail
    let tailBefore = lastPiece
    if (stt.streamed.spec) {
      const f = await within(stt.streamed.spec.format, STREAM_WAIT_MS).catch(() => null)
      if (f === null) return null
      if (f !== 'empty') {
        const at = lastSentenceStart(f.text)
        const head = f.text.slice(0, at).trim()
        const lastSentence = f.text.slice(at)
        if (!tail) specHead = f
        else {
          if (head) specHead = { ...f, text: head }
          tailInput = joinSeam(lastSentence, tail).text
          tailBefore = head || lastPiece
        }
      }
    }
    const tailRequest: FormatInput = {
      ...input,
      transcript: tailInput,
      context: pieceContext(input.context, tailBefore, true)
    }
    const tailFormat = !tailInput
      ? null
      : preformatted && preformatted[0] === tailInput
        ? Promise.resolve(preformatted[1])
        : // A few words after formatted text: rule-based formatting, no model round trip.
          countWords(tail) > 0 && countWords(tail) <= SHORT_TAIL_WORDS && (specHead || stt.streamed.texts.length)
          ? formatTranscript(tailRequest, null)
          : formatter.format(tailRequest)
    tailFormat?.catch(() => undefined)
    type PieceOutcome = Awaited<(typeof streamed.formats)[number]>
    const pieces: PieceOutcome[] = await within(Promise.all(streamed.formats), STREAM_WAIT_MS).catch(
      (): PieceOutcome[] => [null as PieceOutcome]
    )
    if (pieces.some((p) => p === null)) {
      log.info(
        `session ${tag}: a piece was not formatted while speaking; formatting the whole text`
      )
      return null
    }
    const parts = pieces.filter((p): p is FormatOutcome => p !== 'empty' && p !== null)
    if (specHead) parts.push(specHead)
    if (tailFormat) {
      try {
        const t = await tailFormat
        parts.push({ ...t, text: stripEcho(t.text, seamContext(tailBefore)) })
      } catch {
        return null
      }
    }
    if (!parts.length) return null
    log.info(
      `session ${tag}: ${parts.length - (tailFormat ? 1 : 0)} piece(s) formatted while speaking; tail formatted at release`
    )
    return joinFormatted(parts)
  }

  private async transcribeWithFallback(
    wav: Uint8Array,
    prompt: string | undefined,
    keyterms: string[],
    resolved: ResolvedStt,
    tier?: InferenceTier
  ): Promise<TranscribeOutput> {
    // The tier rides on this call only; resolved.cfg is shared with the release.
    const cfg = tier ? { ...resolved.cfg, tier } : resolved.cfg
    const provider = getSttProvider(cfg.kind)
    try {
      return await provider.transcribe({ wav, prompt, keyterms }, cfg)
    } catch (err) {
      const refreshed = await this.deps.inference.refreshedStt(resolved, err)
      if (refreshed) {
        resolved.cfg = refreshed
        return provider.transcribe(
          { wav, prompt, keyterms },
          tier ? { ...refreshed, tier } : refreshed
        )
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

  /** What the model is told about this dictation besides the transcript. */
  formatContext(s: Settings, style: ResolvedStyle, app: AppContext): FormatContext {
    return {
      category: app.category,
      app: app.app || undefined,
      tone: style.tone,
      language: s.stt.language,
      instructions: style.instructions,
      dictionary: s.dictionary,
      // Snippet triggers are expanded after the model; it must leave them alone.
      keepVerbatim: s.snippets.map((x) => x.trigger)
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

  /**
   * `retryId`: the failed dictation's audio is stored, so the pill offers to send it again.
   * `limit`: the plan limit that refused it, so the pill can explain and offer the ways forward.
   * `service`: the Murmur service that is unavailable, so the pill can say so calmly.
   */
  private showError(
    message: string,
    retryId?: string,
    limit?: LimitNotice,
    service?: ServiceNotice
  ): void {
    if (this.deps.settings.get().general.sounds) this.deps.overlay.playSound('error')
    this.deps.overlay.setState({ phase: 'error', message, retryId, limit, service })
  }
}

/** `fast`, or `normal (asked fast, not_configured)` when the instance could not honour the request. */
export function speedLogNote(speed: SpeedOutcome): string {
  return speed.used === speed.requested
    ? speed.used
    : `${speed.used} (asked ${speed.requested}, ${speed.fallback ?? 'fallback'})`
}

/** The plan limit behind an error, when a Murmur instance refused (or paused) on one. */
export function planLimitOf(err: unknown): LimitNotice | undefined {
  if (!(err instanceof SttError) || !err.limit) return undefined
  return isPlanLimit(err.limit.limit) ? err.limit : undefined
}

/** The service notice behind an error, when a Murmur instance said its provider is down. */
export function serviceNoticeOf(err: unknown): ServiceNotice | undefined {
  return err instanceof SttError ? err.service : undefined
}

/**
 * At release, the pieces and tail speculation sent while recording get this long before the whole
 * dictation is transcribed instead (Oct 15 2026: a stalled piece held a release for minutes).
 */
export const STREAM_WAIT_MS = 8_000
/** A release tail of at most this many words is formatted by rules (SHORT_TAIL_WORDS in the gateway). */
export const SHORT_TAIL_WORDS = 6

/**
 * What the one-call release needs, known at release without waiting: the speculation's formatted
 * last sentence (the prefix the tail continues), the text before it, and the base request. Null
 * when the speculation is missing or not formatted yet.
 */
async function releasePlan(
  streamed: StreamedPrefix
): Promise<{ prefix: string; before: string; format: Record<string, unknown> } | null> {
  if (!streamed.spec) return null
  const PENDING = Symbol('pending')
  const spec = await Promise.race([streamed.spec.result.catch(() => null), Promise.resolve(PENDING)])
  if (spec === PENDING || spec === null) return null
  const f = await Promise.race([spec.format.catch(() => null), Promise.resolve(PENDING)])
  if (f === PENDING || f === null || f === 'empty') return null
  const at = lastSentenceStart(f.text)
  const head = f.text.slice(0, at).trim()
  if (!head) return null
  return { prefix: f.text.slice(at), before: head, format: {} }
}
export const RELEASE_TIMEOUT_MESSAGE = 'Murmur took too long to transcribe this — tap Retry'

/** The longest a release may take: 30 s plus 0.1 s per second of audio, at most 75 s. */
export function releaseDeadlineMs(audioSec: number): number {
  return Math.min(75_000, Math.round(30_000 + audioSec * 100))
}

export class ReleaseTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`)
    this.name = 'ReleaseTimeoutError'
  }
}

/** `p`, or a ReleaseTimeoutError once `ms` have passed. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReleaseTimeoutError(ms)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
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
