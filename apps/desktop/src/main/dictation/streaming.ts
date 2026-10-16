import { DEFAULT_CHUNK_PLAN, findCutDetail, findSpecCut, type ChunkPlan } from '@core/audio/chunker'
import { adaptiveThreshold } from '@core/audio/vad'
import { countWords } from '@engine'

/** Transcribes one finished stretch of the dictation; resolves with its text. */
export type ChunkTranscriber = (pcm: Int16Array, index: number) => Promise<string>

/**
 * Speculates on the unfinished stretch after the last piece: transcribes (and formats) it up to a
 * pause while the user keeps talking. Resolves with whatever the session needs at release.
 */
export type TailSpeculator<T> = (pcm: Int16Array) => Promise<T>

/** How often the unfinished stretch is checked for a new pause to speculate up to. */
export const SPEC_CHECK_SEC = 0.5
/** A new speculation needs at least this much more audio than the last one covered. */
export const SPEC_MIN_GAIN_SEC = 2
/** Pauses at least this long are speculation points (mid-sentence ones too; the join repairs). */
export const SPEC_PAUSE_MS = 600

/** A speculation that was running or done at release, and where the audio after it starts. */
export interface TailSpeculation<T> {
  samples: number
  result: Promise<T>
}

/**
 * Pieces sent at once. A long session on a slow network queues the rest instead of opening one
 * request per piece (a 30-minute dictation is ~200 pieces).
 */
export const MAX_PIECES_IN_FLIGHT = 4
/** A piece that fails is sent once more before the dictation falls back to slower paths. */
export const PIECE_RETRIES = 1

/** Runs at most `max` tasks at a time, in the order they were queued. */
export function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: (() => void)[] = []
  const next = (): void => {
    if (active >= max) return
    const go = queue.shift()
    if (go) {
      active++
      go()
    }
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--
            next()
          })
      })
      next()
    })
}

/** Audio repeated at the start of the next piece after a cut that may split a word. */
export const FORCED_OVERLAP_SEC = 1
/** After a clean cut, the next piece starts this far back (still inside the pause). */
export const PAUSE_LEAD_IN_SEC = 0.3

/**
 * Sends a long dictation to speech recognition in pieces while it is still being spoken. The
 * session feeds it the samples recorded so far; at release it hands back how much audio the
 * pieces cover and their texts, and only the rest is transcribed then.
 */
export class ChunkStreamer<T = never> {
  private committed = 0
  private spec: { at: number; restFrom: number; result: Promise<T> } | null = null
  private nextSpecCheck = 0
  /** Samples before `committed` the next piece repeats. */
  private overlap = 0
  private pieces: Promise<string>[] = []
  private nextCheck: number
  private closed = false
  private readonly limit: <R>(task: () => Promise<R>) => Promise<R>
  /** Pieces sent and not answered yet (queued included); the most seen at once. */
  inFlight = 0
  maxInFlight = 0

  constructor(
    private readonly read: (from: number) => Int16Array,
    private readonly transcribe: ChunkTranscriber,
    private readonly sampleRate: number,
    private readonly floorDb: number,
    private readonly plan: ChunkPlan = DEFAULT_CHUNK_PLAN,
    private readonly speculate?: TailSpeculator<T>,
    maxPiecesInFlight = MAX_PIECES_IN_FLIGHT
  ) {
    this.nextCheck = Math.floor(plan.minSec * sampleRate)
    this.limit = limiter(maxPiecesInFlight)
  }

  /** One piece: queued behind the others in flight, and sent once more if it fails. */
  private send(piece: Int16Array, index: number): Promise<string> {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    const attempt = (left: number): Promise<string> =>
      this.limit(() => this.transcribe(piece, index)).catch((err) =>
        left > 0 ? attempt(left - 1) : Promise.reject(err)
      )
    const p = attempt(PIECE_RETRIES)
    void p.then(
      () => this.inFlight--,
      () => this.inFlight--
    )
    return p
  }

  /** Call with the total samples recorded; cheap until a cut is due. */
  onSamples(total: number): void {
    if (this.closed) return
    this.maybeSpeculate(total)
    if (total - this.committed < this.nextCheck) return
    const pending = this.read(this.committed)
    const threshold = adaptiveThreshold(pending, this.sampleRate, this.floorDb)
    const found = findCutDetail(pending, this.sampleRate, threshold, this.plan)
    if (found === null) {
      // Look again in a quarter second.
      this.nextCheck = pending.length + Math.floor(this.sampleRate / 4)
      return
    }
    const cut = found.at
    const head = this.overlap
      ? this.read(this.committed - this.overlap).slice(0, this.overlap)
      : null
    const piece = head ? concat(head, pending.subarray(0, cut)) : pending.slice(0, cut)
    const index = this.pieces.length
    const p = this.send(piece, index)
    p.catch(() => undefined) // awaited in finish(); never an unhandled rejection
    this.pieces.push(p)
    this.committed += cut
    this.spec = null // the piece covers it
    this.nextSpecCheck = 0
    const leadIn = found.forced
      ? FORCED_OVERLAP_SEC
      : Math.min(PAUSE_LEAD_IN_SEC, Math.max(0, found.pauseMs / 2000 - 0.05))
    this.overlap = Math.min(cut, Math.floor(leadIn * this.sampleRate))
    this.nextCheck = Math.floor(this.plan.minSec * this.sampleRate)
  }

  private maybeSpeculate(total: number): void {
    // Short dictations never reach a piece cut (~18 s). Speculating on them makes release wait
    // for an in-flight STT+format of almost the whole clip (desktop log 004edb08: 17 words, 2.7 s).
    // Only speculate on the stretch after at least one piece, where the remainder is the real tail.
    if (!this.speculate || this.committed === 0) return
    if (total - this.committed < this.nextSpecCheck) return
    this.nextSpecCheck = total - this.committed + Math.floor(SPEC_CHECK_SEC * this.sampleRate)
    const pending = this.read(this.committed)
    const threshold = adaptiveThreshold(pending, this.sampleRate, this.floorDb)
    const cut = findSpecCut(pending, this.sampleRate, threshold, SPEC_PAUSE_MS)
    if (!cut) return
    if (this.spec && cut.at < this.spec.at + SPEC_MIN_GAIN_SEC * this.sampleRate) return
    const pcm = this.overlap
      ? this.read(this.committed - this.overlap).slice(0, this.overlap + cut.at)
      : pending.slice(0, cut.at)
    const result = this.speculate(pcm)
    result.catch(() => undefined) // a failed speculation only means the tail is sent whole
    const lead = Math.floor(
      Math.min(PAUSE_LEAD_IN_SEC, Math.max(0, cut.pauseMs / 2000 - 0.05)) * this.sampleRate
    )
    this.spec = { at: cut.at, restFrom: cut.at - lead, result }
  }

  /**
   * The newest speculation on the stretch after the last piece, if any, and where the audio it
   * does not cover starts.
   */
  speculation(): TailSpeculation<T> | null {
    if (!this.spec) return null
    return { samples: this.committed + this.spec.restFrom, result: this.spec.result }
  }

  /**
   * Where the rest of the audio starts (the overlap the next piece would have repeated is
   * included), and the pieces' texts (rejects if any piece failed).
   */
  finish(): { samples: number; texts: Promise<string[]> } {
    this.closed = true
    const texts = Promise.all(this.pieces)
    texts.catch(() => undefined) // the session awaits it later, after resolving its provider
    return { samples: this.committed - this.overlap, texts }
  }

  get piecesSent(): number {
    return this.pieces.length
  }
}

function concat(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Clips longer than this are transcribed in pieces, never as one request (the gateway caps a clip at 600 s). */
export const LONG_CLIP_SEC = 240

/**
 * Transcribes a recording that is already complete in pieces cut at pauses, the same way pieces
 * are cut while recording, at most MAX_PIECES_IN_FLIGHT at a time. For a long dictation whose
 * streamed pieces failed, and for Retry of one: a 30-minute clip never goes up as one request.
 * Resolves with the pieces' texts in order (the last one is the rest after the final cut).
 */
export async function transcribeInPieces(
  pcm: Int16Array,
  sampleRate: number,
  floorDb: number,
  transcribe: ChunkTranscriber,
  plan: ChunkPlan = DEFAULT_CHUNK_PLAN
): Promise<string[]> {
  let total = 0
  const streamer = new ChunkStreamer(
    (from) => pcm.subarray(from, total),
    transcribe,
    sampleRate,
    floorDb,
    plan
  )
  const step = Math.floor(sampleRate / 4)
  for (total = Math.min(step, pcm.length); ; total = Math.min(total + step, pcm.length)) {
    streamer.onSamples(total)
    if (total >= pcm.length) break
  }
  const done = streamer.finish()
  const rest = pcm.subarray(done.samples)
  const pieces = await done.texts
  const last = rest.length >= sampleRate / 4 ? await transcribe(rest, pieces.length) : ''
  return [...pieces, last]
}

/** Above this many words, a whole transcript is formatted in groups (a 30-minute dictation is ~4,500). */
export const LONG_FORMAT_WORDS = 600
/** Words per group when a long transcript is formatted in groups, cut at sentence ends. */
export const FORMAT_GROUP_WORDS = 250

/** Splits a transcript at sentence ends into groups of about `size` words. */
export function formatGroups(text: string, size = FORMAT_GROUP_WORDS): string[] {
  const sentences = text.trim().split(/(?<=[.!?])\s+/)
  const groups: string[] = []
  let cur: string[] = []
  let words = 0
  for (const sentence of sentences) {
    const n = countWords(sentence)
    if (words && words + n > size) {
      groups.push(cur.join(' '))
      cur = []
      words = 0
    }
    cur.push(sentence)
    words += n
  }
  if (cur.length) groups.push(cur.join(' '))
  return groups
}

