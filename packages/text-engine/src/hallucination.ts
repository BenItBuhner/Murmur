import { isNumberWord } from './numbers'

/**
 * Whisper-family models, given a clip with no speech in it (the quiet tail of a streamed
 * dictation, a breath, a click), answer with the closing lines of the videos they were trained
 * on: "Thank you.", "Thanks for watching!", "you". Those words are dropped only when the model
 * itself says the audio held no speech (`no_speech_prob`), or the clip is too short to hold the
 * phrase; a speaker who says "thank you" keeps it.
 */

const PHRASES = [
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'thank you for listening',
  'thank you for watching and see you next time',
  'please subscribe',
  'like and subscribe',
  'subscribe to my channel',
  'subtitles by the amara org community',
  'transcribed by',
  'you',
  'bye',
  'bye bye',
  'okay',
  'so',
  'uh',
  'um',
  'hmm',
  // Oct 29 2026: the production models' answer to a second of silence with a vocabulary prompt.
  'the end'
]
const KNOWN = new Set(PHRASES)

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The whole text is one of the phrases a model says to silence (repeats included). */
export function isSilenceHallucination(text: string): boolean {
  const n = normalizePhrase(text)
  if (!n) return false
  if (KNOWN.has(n)) return true
  // "Thank you. Thank you." and the like.
  for (const p of PHRASES) {
    if (n.length % (p.length + 1) !== p.length) continue
    const parts = n.split(' ')
    const pw = p.split(' ').length
    if (parts.length % pw !== 0) continue
    let all = true
    for (let i = 0; i < parts.length; i += pw)
      if (parts.slice(i, i + pw).join(' ') !== p) all = false
    if (all) return true
  }
  return false
}

/** Shorter than this, a clip cannot hold even "thank you". */
export const TOO_SHORT_FOR_SPEECH_SEC = 0.5
/** A segment the model rates at least this likely to be silence, with only a stock phrase in it. */
export const NO_SPEECH_PROB = 0.6

interface Segment {
  text?: unknown
  no_speech_prob?: unknown
  [k: string]: unknown
}

/**
 * The segments of a verbose answer, minus those that are a stock phrase over silence. Returns
 * null when nothing was dropped (so the answer can be passed through byte for byte).
 */
export function dropSilentSegments(
  answer: { text?: unknown; segments?: unknown },
  clipSec: number | null
): { text: string; segments: Segment[] | undefined } | null {
  const short = clipSec !== null && clipSec < TOO_SHORT_FOR_SPEECH_SEC
  if (Array.isArray(answer.segments) && answer.segments.length) {
    const segments = answer.segments as Segment[]
    const keep = segments.filter((s) => {
      const t = typeof s.text === 'string' ? s.text : ''
      const p = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0
      return !(isSilenceHallucination(t) && (p >= NO_SPEECH_PROB || short))
    })
    if (keep.length === segments.length) return null
    const text = keep
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .join('')
      .trim()
    return { text, segments: keep }
  }
  const text = typeof answer.text === 'string' ? answer.text : ''
  if (short && isSilenceHallucination(text)) return { text: '', segments: undefined }
  return null
}

/** Voiced time below which a stock phrase is taken for silence ("thank you" itself is ~400 ms voiced). */
export const TAIL_PHRASE_MIN_SPEECH_MS = 120

/**
 * A stock phrase is dropped only on audio evidence: the model rated it as silence, or (without a
 * rating) the audio held almost no voiced frames. Never on the text alone.
 */
export function isSilentStockPhrase(
  text: string,
  speechMs: number,
  noSpeechProb?: number
): boolean {
  if (!isSilenceHallucination(text)) return false
  if (noSpeechProb !== undefined) return noSpeechProb >= NO_SPEECH_PROB
  return speechMs < TAIL_PHRASE_MIN_SPEECH_MS
}

export interface TimedWord {
  word: string
  start: number
  end: number
}

/**
 * The stock phrase a transcript ends with ("…right to me. Thank you."), as its last `count` timed
 * words and where they start, or null. Only phrases of PHRASES, up to six words.
 */
export function trailingStockPhrase(
  words: readonly TimedWord[]
): { count: number; start: number; end: number } | null {
  for (let count = Math.min(6, words.length); count >= 1; count--) {
    const tail = words.slice(words.length - count)
    if (isSilenceHallucination(tail.map((w) => w.word).join(' ')))
      return { count, start: tail[0].start, end: tail[count - 1].end }
  }
  return null
}

/** Pitched (voiced) audio under a stock phrase below which nobody said it: "thank you" has ~250 ms. */
export const STOCK_PHRASE_MIN_PITCHED_MS = 80

/** `text` without its last `count` words (and the punctuation that followed them). */
export function dropLastWords(text: string, count: number): string {
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
  const starts: number[] = []
  for (const m of text.matchAll(re)) starts.push(m.index)
  if (count <= 0 || starts.length < count) return text
  return text.slice(0, starts[starts.length - count]).trimEnd()
}

/** Shortest and longest run of words a recognizer loop repeats ("Step 5 shows the keyboard."). */
const LOOP_MIN_WORDS = 3
const LOOP_MAX_WORDS = 12
/** Back-to-back copies that make a loop: a speaker may say a phrase twice, not three times. */
const LOOP_MIN_COPIES = 3

/**
 * Speech models can get stuck and write one phrase over and over where the speaker said it once
 * ("…step 5 shows the keyboard. Step 5 shows the keyboard. Step 5 shows the keyboard…"). A run of
 * 3 to 12 words that appears 3 or more times back to back keeps its first copy. Runs of numbers
 * only are left alone: "one two three, one two three, one two three" may have been read out.
 */
export function collapseLoops(text: string): string {
  const words = [...text.matchAll(/\S+/gu)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    key: m[0].toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
  }))
  if (words.length < LOOP_MIN_WORDS * LOOP_MIN_COPIES) return text
  let out = ''
  let from = 0 // text before this offset is already in `out`
  let i = 0
  while (i < words.length) {
    let found: { k: number; copies: number } | null = null
    for (let k = LOOP_MIN_WORDS; k <= LOOP_MAX_WORDS && i + k * LOOP_MIN_COPIES <= words.length; k++) {
      const unit = words.slice(i, i + k)
      if (unit.some((w) => !w.key)) continue
      if (unit.every((w) => isNumberWord(w.key) || /^\d/.test(w.key))) continue
      let copies = 1
      while (
        i + (copies + 1) * k <= words.length &&
        unit.every((w, j) => words[i + copies * k + j].key === w.key)
      )
        copies++
      if (copies >= LOOP_MIN_COPIES) {
        found = { k, copies }
        break
      }
    }
    if (!found) {
      i++
      continue
    }
    // Keep the first copy (with its punctuation), then go on from where the copies end.
    out += text.slice(from, words[i + found.k - 1].end)
    const next = i + found.k * found.copies
    from = next < words.length ? words[next].start : text.length
    if (next < words.length) out += ' '
    i = next
  }
  return out + text.slice(from)
}

/**
 * A made-up ending: speech models sometimes replace the last seconds of real speech with stock
 * filler that repeats itself ("…everything of the sort I think it's a good thing to do with the
 * data, and I think it's really important to do with the data.", Nov 9 2026; the speaker said
 * "should be done in the cloud threads for us instead, please"). True when a run of 4 words shows
 * up twice in the last 30 words and nowhere before them. A speaker who repeats a phrase for
 * emphasis earlier in the dictation does not trip it, and the caller only transcribes again.
 */
export function suspectTail(text: string): boolean {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [])
  if (words.length < 12) return false
  const cut = Math.max(0, words.length - 30)
  const head = words.slice(0, cut).join(' ')
  const tail = words.slice(cut)
  const seen = new Map<string, number>()
  for (let i = 0; i + 4 <= tail.length; i++) {
    const run = tail.slice(i, i + 4)
    if (run.every((w) => isNumberWord(w) || /^\d/.test(w))) continue
    const key = run.join(' ')
    const at = seen.get(key)
    if (at !== undefined && i - at >= 4 && !head.includes(key)) return true
    if (at === undefined) seen.set(key, i)
  }
  return false
}
