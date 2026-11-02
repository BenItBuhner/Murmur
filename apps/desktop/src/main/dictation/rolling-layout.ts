import {
  countWords,
  rawSeamContinues,
  wantsLayout,
  type AppCategory,
  type Layout,
  type LayoutResult
} from '@engine'
import type { FormatOutcome } from '../inference/router'

/** A layout answer for the first `parts` formatted pieces, whose joined text was `prefix`. */
export interface LaidPrefix {
  parts: number
  prefix: string
  laid: LayoutResult
}

/** New words before the formatted pieces are laid out again (two pieces, about a minute). */
export const RELAYOUT_WORDS = 100

/**
 * Paragraphs and lists for a long dictation, worked out while the user is still talking, so the
 * release never waits for them. Each piece's formatting is reported as it settles; once the
 * pieces formatted so far (in order, none missing) hold enough new words, they are laid out again
 * in the background, one request at a time. At release the newest answer that has already arrived
 * is used, and whatever was said after it joins the laid-out text as it is.
 */
export class RollingLayout {
  private settled: Array<FormatOutcome | 'empty' | null | undefined> = []
  /** Each piece's text as the recognizer gave it, for how its seams join. */
  private raws: string[] = []
  private running = false
  private latest: LaidPrefix | null = null
  private laidWords = 0
  /** Pieces in the last request sent, so a failed one is not sent again until a piece is added. */
  private tried = 0

  constructor(
    private readonly category: AppCategory,
    private readonly layout: (text: string) => Promise<LayoutResult>,
    private readonly join: (parts: FormatOutcome[], continues: boolean[]) => string,
    private minNewWords = RELAYOUT_WORDS,
    /** The profile's layout: `minimal` never lays out, `structured` also in chat. */
    private readonly profileLayout?: Layout
  ) {}

  /** Piece `index` was formatted ('empty': no speech; null: not formatted, which stops the layout there). */
  settle(index: number, value: FormatOutcome | 'empty' | null, raw = ''): void {
    this.settled[index] = value
    this.raws[index] = raw
    this.kick()
  }

  /** The newest layout that has arrived; never waits for one in flight. */
  current(): LaidPrefix | null {
    return this.latest
  }

  /** At the key-up: lay out every piece formatted so far, however few words are new. */
  flush(): void {
    this.minNewWords = 1
    this.kick()
  }

  private kick(): void {
    if (this.running) return
    const parts: FormatOutcome[] = []
    const raws: string[] = []
    for (let i = 0; i < this.settled.length; i++) {
      const v = this.settled[i]
      if (v === undefined || v === null) break
      if (v === 'empty') continue
      if (v.status.outcome !== 'used' && v.status.outcome !== 'skipped-clean') break
      parts.push(v)
      raws.push(this.raws[i] ?? '')
    }
    if (parts.length <= this.tried) return
    const continues = raws.slice(0, -1).map((raw, k) => rawSeamContinues(raw, raws[k + 1]))
    const prefix = this.join(parts, continues)
    const words = countWords(prefix)
    if (
      words - this.laidWords < this.minNewWords ||
      !wantsLayout(prefix, this.category, this.profileLayout)
    )
      return
    this.running = true
    this.tried = parts.length
    void this.layout(prefix)
      .then((laid) => {
        // A layout that failed keeps the one before; the next piece tries again.
        if (laid.outcome !== 'failed') {
          this.latest = { parts: parts.length, prefix, laid }
          this.laidWords = words
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.running = false
        this.kick()
      })
  }
}
