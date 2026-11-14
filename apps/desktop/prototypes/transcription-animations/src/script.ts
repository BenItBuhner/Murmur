/**
 * The one script every concept (and the real overlay) plays: the same words at the same times, the
 * same voice level, the same phase changes. Times are milliseconds from the start of the take.
 */
export type Tone = 'neutral' | 'frustrated' | 'excited' | 'asking'
export type Phase = 'idle' | 'listening' | 'processing' | 'success'

export const LISTEN_START = 600
export const LISTEN_END = 8600
export const PROCESS_END = 9800
export const SUCCESS_END = 11200
export const DURATION = 12000

/** Raw words as the streaming recogniser would emit them, with start times. */
const RAW =
  'okay so the launch slipped again which is honestly really frustrating ' +
  'but the new build is incredible and im so excited about it ' +
  'can we ship it on friday'
/** What cleanup inserts once the take ends (the text engine's job). */
export const CLEAN =
  "Okay, so the launch slipped again, which is honestly really frustrating. But the new build is incredible, and I'm so excited about it. Can we ship it on Friday?"

/** Pauses (ms) after these word indices, where a speaker breathes. */
const PAUSE_AFTER: Record<number, number> = { 1: 220, 10: 520, 22: 480 }

export interface Word {
  i: number
  raw: string
  /** The word as it reads in the clean text (punctuation, capitals). */
  text: string
  start: number
  end: number
}

export const WORDS: Word[] = (() => {
  const raw = RAW.split(' ')
  const clean = CLEAN.split(' ')
  const out: Word[] = []
  let t = LISTEN_START + 420
  raw.forEach((w, i) => {
    const dur = 150 + w.length * 22
    out.push({ i, raw: w, text: clean[i] ?? w, start: t, end: t + dur })
    t += dur + 40 + (PAUSE_AFTER[i] ?? 0)
  })
  // Stretch to fill the listening window so the take ends with a short tail of silence.
  const scale = (LISTEN_END - 380 - (LISTEN_START + 420)) / (t - (LISTEN_START + 420))
  return out.map((w) => ({
    ...w,
    start: LISTEN_START + 420 + (w.start - LISTEN_START - 420) * scale,
    end: LISTEN_START + 420 + (w.end - LISTEN_START - 420) * scale
  }))
})()

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

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Microphone level 0..1: syllable bumps inside each word, near-silence in the gaps. */
export function levelAt(t: number): number {
  if (t < LISTEN_START || t > LISTEN_END) return 0
  let v = 0.04 + 0.02 * hash(Math.floor(t / 45))
  for (const w of WORDS) {
    if (t < w.start - 30 || t > w.end + 60) continue
    const p = (t - w.start) / (w.end - w.start)
    const syl = Math.max(1, Math.round(w.raw.length / 3))
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, p)))
    const bumps = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * syl * p))
    const stress = 0.55 + 0.45 * hash(w.i)
    v = Math.max(v, env * bumps * stress * (toneOfWord(w.i) === 'excited' ? 1 : 0.85))
  }
  return Math.min(1, v)
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
