import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AppCategory } from '../src/types'
import type { LayoutPlan } from '../src/layout'

/**
 * Long dictations, for what only shows up past a minute of talking: pieces cut at pauses and
 * joined again, paragraphs and lists.
 *
 * A sample in eval/long/*.txt is what someone said, one sentence per line, with the layout they
 * meant marked in the file:
 *
 *   # id | category       the first line
 *   (blank line)          the next sentence starts a paragraph
 *   1) Step one ...       an ordered list item starts here (the marker is not spoken)
 *   - We move ...         an unordered list item starts here
 *     More of the item    (two spaces) a sentence that continues the item above
 *
 * `spoken` is the perfect transcript (the words as said, punctuated, no line breaks).
 */

export interface LongSentence {
  text: string
  paragraphStart: boolean
  /** Index of the list this sentence starts an item of, if it does. */
  itemOf?: number
  /** Inside a list (an item's first sentence or its continuation). */
  inList?: number
}

export interface LongSample {
  id: string
  category: AppCategory
  sentences: LongSentence[]
  lists: Array<{ ordered: boolean }>
  spoken: string
}

const DIR = resolve(import.meta.dirname, 'long')

export function parseSample(source: string): LongSample {
  const lines = source.replace(/\r/g, '').split('\n')
  const head = /^#\s*(\S+)\s*\|\s*(\S+)/.exec(lines[0])
  if (!head) throw new Error(`sample header: ${lines[0]}`)
  const sentences: LongSentence[] = []
  const lists: LongSample['lists'] = []
  let paragraph = false
  let list: number | undefined
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) {
      paragraph = true
      list = undefined
      continue
    }
    const ordered = /^(\d+)\)\s+/.exec(raw)
    const bullet = /^-\s+/.exec(raw)
    const cont = /^ {2}\S/.test(raw)
    let s: LongSentence
    if (ordered || bullet) {
      const isOrdered = !!ordered
      if (list === undefined || lists[list].ordered !== isOrdered) {
        lists.push({ ordered: isOrdered })
        list = lists.length - 1
      }
      s = {
        text: raw.slice((ordered ?? bullet)![0].length).trim(),
        paragraphStart: false,
        itemOf: list,
        inList: list
      }
    } else if (cont && list !== undefined) {
      s = { text: raw.trim(), paragraphStart: false, inList: list }
    } else {
      list = undefined
      s = { text: raw.trim(), paragraphStart: paragraph && sentences.length > 0 }
    }
    sentences.push(s)
    paragraph = false
  }
  return {
    id: head[1],
    category: head[2] as AppCategory,
    sentences,
    lists,
    spoken: sentences.map((s) => s.text).join(' ')
  }
}

export function loadLongSamples(): LongSample[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => parseSample(readFileSync(resolve(DIR, f), 'utf8')))
}

/** The plan a perfect layout model would answer for a sample. */
export function oraclePlan(sample: LongSample): LayoutPlan {
  const paragraphs = sample.sentences.flatMap((s, i) => (s.paragraphStart ? [i] : []))
  const lists = sample.lists.map((l, k) => {
    const items = sample.sentences.flatMap((s, i) => (s.itemOf === k ? [i] : []))
    let end = items[0]
    sample.sentences.forEach((s, i) => {
      if (s.inList === k) end = i
    })
    return { items, end, ordered: l.ordered }
  })
  return { paragraphs, lists }
}

// --- Cutting a dictation into pieces the way streaming does --------------------------------------

/** A small seeded generator, so every run cuts the same way. */
export function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PieceOptions {
  /** Words per piece: 18 to 30 s of speech at ~150 words a minute is 45 to 75. */
  minWords?: number
  maxWords?: number
  /** Share of cuts that land on a sentence end (the rest fall on a pause mid-sentence). */
  atSentenceEnd?: number
  /** Share of mid-sentence cuts forced at 30 s, which repeat ~1 s (2 to 3 words) in the next piece. */
  overlap?: number
}

/**
 * The spoken transcript as speech recognition returns it in streamed pieces: each piece starts
 * capitalized and most end with a period, wherever the cut fell, because the recognizer sees each
 * one as a whole utterance.
 */
export function cutPieces(spoken: string, rand: () => number, opts: PieceOptions = {}): string[] {
  const { minWords = 45, maxWords = 75, atSentenceEnd = 0.4, overlap = 0.15 } = opts
  const ws = spoken.split(/\s+/).filter(Boolean)
  const ends = new Set(ws.flatMap((w, i) => (/[.!?]["')]*$/.test(w) ? [i + 1] : [])))
  const pieces: string[] = []
  let start = 0
  while (start < ws.length) {
    let end = Math.round(start + minWords + rand() * (maxWords - minWords))
    let repeat = 0
    if (end >= ws.length - 8) end = ws.length
    else if (rand() < atSentenceEnd) {
      for (let d = 0; d <= 10; d++)
        if (ends.has(end + d)) {
          end += d
          break
        } else if (ends.has(end - d)) {
          end -= d
          break
        }
    } else if (rand() < overlap) repeat = 2 + Math.floor(rand() * 2)
    const words = ws.slice(start, end)
    pieces.push(asRecognized(words, rand))
    start = end - (end < ws.length ? repeat : 0)
  }
  return pieces
}

function asRecognized(words: string[], rand: () => number): string {
  const out = [...words]
  out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1)
  const last = out.length - 1
  if (!/[.!?]["')]*$/.test(out[last])) {
    const bare = out[last].replace(/[,;:]+$/, '')
    out[last] = rand() < 0.75 ? `${bare}.` : bare
  }
  return out.join(' ')
}

// --- Scoring ------------------------------------------------------------------------------------

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')

export interface Token {
  word: string
  /** The word as written, with its case and punctuation. */
  raw: string
}

export function tokens(text: string): Token[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({ raw, word: norm(raw) }))
    .filter((t) => t.word)
}

/** Word alignment: for each hypothesis token, the reference token it matches, or -1. */
export function align(ref: Token[], hyp: Token[]): { errors: number; map: number[] } {
  const n = ref.length
  const m = hyp.length
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (ref[i - 1].word === hyp[j - 1].word ? 0 : 1)
      )
  const map = new Array<number>(m).fill(-1)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (ref[i - 1].word === hyp[j - 1].word ? 0 : 1)) {
      if (ref[i - 1].word === hyp[j - 1].word) map[j - 1] = i - 1
      i--
      j--
    } else if (d[i][j] === d[i - 1][j] + 1) i--
    else j--
  }
  return { errors: d[n][m], map }
}

const ENDS = /[.!?]["')\]]*$/
const OPENS_LOWER = /^[a-z]/

export interface SeamScore {
  words: number
  /** Word error rate against the spoken words (case and punctuation ignored). */
  wer: number
  /** A sentence ended where the speaker did not end one (a cut closed it). */
  falseBreaks: number
  /** A sentence the speaker ended runs on into the next. */
  missedBreaks: number
  /** A word the speaker did not start a sentence with is capitalized. */
  falseCaps: number
}

/** Sentence boundaries and capitals in `hyp` against the spoken transcript. */
export function scoreSeams(spoken: string, hyp: string): SeamScore {
  const ref = tokens(spoken)
  const h = tokens(hyp)
  const { errors, map } = align(ref, h)
  let falseBreaks = 0
  let falseCaps = 0
  const refEnds = new Set(ref.flatMap((t, i) => (ENDS.test(t.raw) ? [i] : [])))
  const kept = new Set<number>()
  for (let j = 0; j < h.length; j++) {
    const i = map[j]
    if (i < 0) continue
    const hypEnds = ENDS.test(h[j].raw)
    if (hypEnds && refEnds.has(i)) kept.add(i)
    if (hypEnds && !refEnds.has(i) && i < ref.length - 1) falseBreaks++
    // "I" and proper names are capitalized in the spoken text too; only a lowercase word counts.
    if (i > 0 && OPENS_LOWER.test(ref[i].raw) && /^[A-Z]/.test(h[j].raw)) falseCaps++
  }
  const missedBreaks = [...refEnds].filter((i) => i < ref.length - 1 && !kept.has(i)).length
  return { words: ref.length, wer: errors / ref.length, falseBreaks, missedBreaks, falseCaps }
}

export interface LayoutScore {
  paragraphs: { expected: number; found: number; matched: number }
  items: { expected: number; found: number; matched: number }
}

/**
 * Paragraph starts and list items in a laid-out text against the sample, by the sentence they
 * fall on (a paragraph one sentence off still counts: where a topic turns is a judgment call).
 */
export function scoreLayout(sample: LongSample, text: string): LayoutScore {
  const ref = tokens(sample.spoken)
  const firstWord: number[] = []
  let w = 0
  for (const s of sample.sentences) {
    firstWord.push(w)
    w += tokens(s.text).length
  }
  const sentenceOf = (i: number): number => {
    let k = 0
    while (k + 1 < firstWord.length && firstWord[k + 1] <= i) k++
    return k
  }
  const blocks = text.split(/\n/)
  const hypTokens: Token[] = []
  const paraAt: number[] = []
  const itemAt: number[] = []
  let blank = false
  for (const b of blocks) {
    if (!b.trim()) {
      blank = true
      continue
    }
    const isItem = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/.test(b)
    const ts = tokens(b.replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/, ''))
    if (hypTokens.length && ts.length) {
      if (isItem) itemAt.push(hypTokens.length)
      else if (blank) paraAt.push(hypTokens.length)
    } else if (isItem && ts.length) itemAt.push(0)
    hypTokens.push(...ts)
    blank = false
  }
  const { map } = align(ref, hypTokens)
  const toSentence = (j: number): number => {
    for (let k = j; k < map.length; k++) if (map[k] >= 0) return sentenceOf(map[k])
    return -1
  }
  const expectedParas = sample.sentences.flatMap((s, i) => (s.paragraphStart ? [i] : []))
  const expectedItems = sample.sentences.flatMap((s, i) => (s.itemOf !== undefined ? [i] : []))
  const foundParas = paraAt.map(toSentence)
  const foundItems = itemAt.map(toSentence)
  const near = (xs: number[], x: number, tol: number): boolean =>
    xs.some((y) => Math.abs(y - x) <= tol)
  return {
    paragraphs: {
      expected: expectedParas.length,
      found: foundParas.length,
      matched: expectedParas.filter((p) => near(foundParas, p, 1) || near(foundItems, p, 0)).length
    },
    items: {
      expected: expectedItems.length,
      found: foundItems.length,
      matched: expectedItems.filter((p) => near(foundItems, p, 0)).length
    }
  }
}
