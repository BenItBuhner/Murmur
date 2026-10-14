import { DEFAULT_CHUNK_PLAN, findCut, type ChunkPlan } from '@core/audio/chunker'
import { adaptiveThreshold } from '@core/audio/vad'

/** Transcribes one finished stretch of the dictation; resolves with its text. */
export type ChunkTranscriber = (pcm: Int16Array, index: number) => Promise<string>

/**
 * Sends a long dictation to speech recognition in pieces while it is still being spoken. The
 * session feeds it the samples recorded so far; at release it hands back how much audio the
 * pieces cover and their texts, and only the rest is transcribed then.
 */
export class ChunkStreamer {
  private committed = 0
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
    const cut = findCut(pending, this.sampleRate, threshold, this.plan)
    if (cut === null) {
      // Look again in a quarter second.
      this.nextCheck = pending.length + Math.floor(this.sampleRate / 4)
      return
    }
    const piece = pending.slice(0, cut)
    const index = this.pieces.length
    const p = this.transcribe(piece, index)
    p.catch(() => undefined) // awaited in finish(); never an unhandled rejection
    this.pieces.push(p)
    this.committed += cut
    this.nextCheck = Math.floor(this.plan.minSec * this.sampleRate)
  }

  /** Samples already sent, and the pieces' texts (rejects if any piece failed). */
  finish(): { samples: number; texts: Promise<string[]> } {
    this.closed = true
    const texts = Promise.all(this.pieces)
    texts.catch(() => undefined) // the session awaits it later, after resolving its provider
    return { samples: this.committed, texts }
  }

  get piecesSent(): number {
    return this.pieces.length
  }
}
