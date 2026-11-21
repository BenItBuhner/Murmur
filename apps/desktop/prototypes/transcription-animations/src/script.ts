/**
 * The one script every concept (and the real overlay) plays: the same words at the same times, the
 * same voice level, the same phase changes. Times are milliseconds from the start of the take.
 */
export type Tone = 'neutral' | 'frustrated' | 'excited' | 'asking'
export type Phase = 'idle' | 'listening' | 'processing' | 'success'

import take from './take.json'

/**
 * The take: a synthesised voice reading the script (voice.wav), its loudness envelope at 60 fps and
 * the word timings. Every concept, and the real pill, plays exactly this.
 */
export const LISTEN_START = 600
export const LISTEN_END = Math.round(take.listenEnd * 1000)
export const PROCESS_END = LISTEN_END + 1100
export const SUCCESS_END = PROCESS_END + 1500
export const DURATION = SUCCESS_END + 800

/** What cleanup inserts once the take ends (the text engine's job). */
export const CLEAN = take.words.map((w) => w.text).join(' ')

export interface Word {
  i: number
  raw: string
  /** The word as it reads in the clean text (punctuation, capitals). */
  text: string
  start: number
  end: number
}

export const WORDS: Word[] = take.words.map((w, i) => ({
  i,
  raw: w.text
    .toLowerCase()
    .replace(/[^a-z']/g, '')
    .replace("'", ''),
  text: w.text,
  start: w.start * 1000,
  end: w.end * 1000
}))

export function phaseAt(t: number): Phase {
  if (t < LISTEN_START) return 'idle'
  if (t < LISTEN_END) return 'listening'
  if (t < PROCESS_END) return 'processing'
  if (t < SUCCESS_END) return 'success'
  return 'idle'
}

/** Words the recogniser has emitted by `t` (each lands ~140ms after its first sound, like a streaming partial). */
export function wordsAt(t: number): Word[] {
  return WORDS.filter((w) => w.start + 140 <= t)
}

/** Microphone level 0..1 at t, read from the take's envelope. */
export function levelAt(t: number): number {
  if (t < LISTEN_START || t > LISTEN_END) return 0
  const f = (t / 1000) * take.fps
  const i = Math.floor(f)
  const a = take.env[i] ?? 0
  const b = take.env[i + 1] ?? 0
  return a + (b - a) * (f - i)
}

// ---- tone / content: a lexicon stand-in for the model (see README) ---------------------------
const LEX: Record<string, Tone> = {
  slipped: 'frustrated',
  frustrating: 'frustrated',
  again: 'frustrated',
  incredible: 'excited',
  excited: 'excited',
  can: 'asking'
}

/** Clause boundaries the recogniser hears as pauses (same indices as PAUSE_AFTER). */
const CLAUSES = [
  [0, 1],
  [2, 10],
  [11, 22],
  [23, 28]
]

/** Tone of the clause holding word i, as known once the words heard so far are classified. */
export function toneOfWord(i: number, heard = Infinity): Tone {
  const c = CLAUSES.find(([a, b]) => i >= a && i <= b)
  if (!c) return 'neutral'
  for (let k = c[0]; k <= Math.min(c[1], heard); k++) {
    const tone = LEX[WORDS[k]?.raw ?? '']
    if (tone) return tone
  }
  return 'neutral'
}

/** The live tone at time t: the tone of the clause being spoken, as classified so far. */
export function toneAt(t: number): Tone {
  const heard = wordsAt(t)
  if (!heard.length) return 'neutral'
  const last = heard[heard.length - 1].i
  return toneOfWord(last, last)
}

export interface Entity {
  word: number
  kind: 'topic' | 'date' | 'question' | 'feeling'
  label: string
}
/** Content the model would pull out of the stream: what it is about, when, and what is asked. */
export const ENTITIES: Entity[] = [
  { word: 3, kind: 'topic', label: 'Launch' },
  { word: 10, kind: 'feeling', label: 'Blocker' },
  { word: 13, kind: 'topic', label: 'New build' },
  { word: 25, kind: 'question', label: 'Ship?' },
  { word: 28, kind: 'date', label: 'Fri, Nov 20' }
]
