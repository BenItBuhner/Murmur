import { DEFAULT_CHUNK_PLAN, findCutDetail, type ChunkPlan } from '@core/audio/chunker'
import { adaptiveThreshold } from '@core/audio/vad'

/** Transcribes one finished stretch of the dictation; resolves with its text. */
export type ChunkTranscriber = (pcm: Int16Array, index: number) => Promise<string>

/** Audio repeated at the start of the next piece after a cut that may split a word. */
export const FORCED_OVERLAP_SEC = 1
/** After a clean cut, the next piece starts this far back (still inside the pause). */
export const PAUSE_LEAD_IN_SEC = 0.3

/**
 * Sends a long dictation to speech recognition in pieces while it is still being spoken. The
 * session feeds it the samples recorded so far; at release it hands back how much audio the
 * pieces cover and their texts, and only the rest is transcribed then.
 */
export class ChunkStreamer {
  private committed = 0
  /** Samples before `committed` the next piece repeats. */
  private overlap = 0
  private pieces: Promise<string>[] = []
  private nextCheck: number
  private closed = false

  constructor(
    private readonly read: (from: number) => Int16Array,
    private readonly transcribe: ChunkTranscriber,
    private readonly sampleRate: number,
    private readonly floorDb: number,
    private readonly plan: ChunkPlan = DEFAULT_CHUNK_PLAN
  ) {
    this.nextCheck = Math.floor(plan.minSec * sampleRate)
  }

  /** Call with the total samples recorded; cheap until a cut is due. */
  onSamples(total: number): void {
    if (this.closed || total - this.committed < this.nextCheck) return
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
    const p = this.transcribe(piece, index)
    p.catch(() => undefined) // awaited in finish(); never an unhandled rejection
    this.pieces.push(p)
    this.committed += cut
    const leadIn = found.forced
      ? FORCED_OVERLAP_SEC
      : Math.min(PAUSE_LEAD_IN_SEC, Math.max(0, found.pauseMs / 2000 - 0.05))
    this.overlap = Math.min(cut, Math.floor(leadIn * this.sampleRate))
    this.nextCheck = Math.floor(this.plan.minSec * this.sampleRate)
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
