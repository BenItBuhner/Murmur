import { isSilenceHallucination } from './hallucination'

/**
 * Answers a speech model gives to audio with nobody speaking in it, and the audio evidence that
 * nobody was. Measured Nov 16 2026 on the production models (apps/inference-worker/eval): they
 * report no_speech_prob 0 on pure silence, so dropSilentSegments never fired, and answered
 *   3 s of silence          -> "Thank you." (one segment running to 29.98 s on a 3 s clip)
 *   2 s of hiss             -> "Gracias."
 *   4 s of room noise       -> "The", "Thank you for watching."
 *   6 s of music            -> "Music playing."
 *   noise with a seam prompt -> the prompt's own words, or a loop ("I am not sure if you can see
 *                               it but I am not sure if you can see it but ...")
 * and "." or "..." for most other quiet clips. Each of those reached the user as words they never
 * said. An answer is dropped only when it is suspect (a stock phrase, a caption, a run of the
 * prompt, a loop) and the audio backs that up (a segment past the end of the clip, or a clip
 * whose loudness never moves the way speech does). A speaker who says "thank you" keeps it.
 */

/** Captions and closings models print for non-speech; only ever dropped with audio evidence. */
const CAPTIONS = new Set([
  'music',
  'music playing',
  'upbeat music',
  'soft music',
  'applause',
  'laughter',
  'silence',
  'noise',
  'background noise',
  'gracias',
  'merci',
  'danke',
  'obrigado',
  'the',
  'a',
  'i',
  'oh',
  'ah',
  'hm',
  'mm',
  'thank you for watching',
  'thanks for watching',
  'see you next time',
  'see you in the next video'
])

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** No letters or digits at all: ".", "...", "♪". */
export function isEmptyAnswer(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/** A sentence, phrase or caption models say over non-speech. */
export function isStockAnswer(text: string): boolean {
  const n = norm(text)
  if (!n) return false
  if (CAPTIONS.has(n) || isSilenceHallucination(text)) return true
  // "[Music]", "(applause)", "♪ ... ♪"
  return /^\s*[[(♪*].*[\])♪*]\s*$/u.test(text.trim())
}

const PURE_CAPTIONS = /^(?:(?:soft |upbeat |background )?music(?: playing)?|applause|laughter|background noise)$/

/** A caption for a sound, not something anyone says: "Music playing.", "[Applause]". */
export function isCaption(text: string): boolean {
  return PURE_CAPTIONS.test(norm(text)) || /^\s*[[(♪*].*[\])♪*]\s*$/u.test(text.trim())
}

/** The answer is three or more words that run, in order, inside the prompt (it was read back). */
export function isPromptRun(text: string, prompt: string | undefined): boolean {
  if (!prompt) return false
  const a = norm(text).split(' ').filter(Boolean)
  if (a.length < 3) return false
  const p = ` ${norm(prompt)} `
  return p.includes(` ${a.join(' ')} `)
}

/** The same phrase of three or more words over and over: a decoding loop. */
export function isLoop(text: string, compressionRatio?: number): boolean {
  if (typeof compressionRatio === 'number' && compressionRatio > 2.2) return true
  const w = norm(text).split(' ').filter(Boolean)
  // The answer is one phrase of n words said again and again (the last time maybe cut short).
  for (let n = 3; n * 2.5 <= w.length; n++) if (w.every((x, i) => x === w[i % n])) return true
  return false
}

/** 16-bit PCM samples of a WAV, or null when the clip is not one (Ogg/Opus, float, garbage). */
export function wavPcm16(bytes: Uint8Array): { samples: Int16Array; rate: number } | null {
  if (bytes.length < 44) return null
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 12
  let rate = 0
  let channels = 1
  let bits = 0
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 1) return null
      channels = view.getUint16(body + 2, true)
      rate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (bits !== 16 || !rate) return null
      const end = Math.min(bytes.length, body + size)
      const frames = Math.floor((end - body) / (2 * channels))
      const samples = new Int16Array(frames)
      for (let i = 0; i < frames; i++) samples[i] = view.getInt16(body + i * 2 * channels, true)
      return { samples, rate }
    }
    o = body + size + (size & 1)
  }
  return null
}

/**
 * Does the clip's loudness move the way speech does? Speech alternates syllables with gaps, so a
 * good share of 30 ms frames stand well above the clip's quietest frames; silence, hiss, hum and
 * steady room noise stay within a few dB of their own floor. Pure digital silence has no frames
 * above it at all. Not a speech detector: only used to back up a suspect answer.
 */
export function hasSpeechDynamics(samples: Int16Array, rate: number): boolean {
  const len = Math.max(1, Math.round(rate * 0.03))
  const db: number[] = []
  for (let i = 0; i + len <= samples.length; i += len) {
    let sum = 0
    for (let j = i; j < i + len; j++) sum += samples[j] * samples[j]
    db.push(10 * Math.log10(sum / len + 1e-9))
  }
  if (db.length < 3) return false
  const sorted = [...db].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)]
  // -60 dBFS: below this a frame is silence however it moves (32768² * 1e-6 ≈ 1074, ~30 dB).
  const audible = 10 * Math.log10(32768 * 32768) - 60
  const lively = db.filter((d) => d > audible && d - floor >= 12).length
  return lively / db.length >= 0.08
}

interface Seg {
  text?: unknown
  end?: unknown
  compression_ratio?: unknown
  [k: string]: unknown
}

/**
 * The answer with what was said over non-speech removed, or null to keep it as it is. Whole
 * answers only: a dictation that ends in "Thank you." keeps it unless that segment alone is
 * suspect and the clip has no speech dynamics at all (then nothing in it was speech).
 */
export function dropNoSpeechAnswer(
  answer: { text?: unknown; segments?: unknown },
  audio: Uint8Array,
  clipSec: number | null,
  prompt: string | undefined
): { text: string; segments: Seg[] | undefined; reason: string } | null {
  const text = typeof answer.text === 'string' ? answer.text : ''
  if (!text.trim()) return null
  const segs = Array.isArray(answer.segments) ? (answer.segments as Seg[]) : undefined
  if (isEmptyAnswer(text)) return { text: '', segments: segs ? [] : undefined, reason: 'no-words' }
  const ratio = segs?.reduce((m, s) => Math.max(m, typeof s.compression_ratio === 'number' ? s.compression_ratio : 0), 0)
  const suspect = isStockAnswer(text)
    ? 'stock'
    : isPromptRun(text, prompt)
      ? 'prompt-run'
      : isLoop(text, ratio)
        ? 'loop'
        : null
  if (!suspect) return null
  // A caption is never dictation: "Music playing." on its own is the model describing the room.
  if (isCaption(text)) return { text: '', segments: segs ? [] : undefined, reason: 'caption' }
  const overrun =
    clipSec !== null &&
    !!segs?.some((s) => typeof s.end === 'number' && s.end > clipSec + 1.5)
  let quiet = false
  // Under 1.5 s a single spoken word can be one unbroken syllable with no gap to measure against.
  if (!overrun && (clipSec === null || clipSec >= 1.5)) {
    const pcm = wavPcm16(audio)
    quiet = pcm !== null && !hasSpeechDynamics(pcm.samples, pcm.rate)
  }
  if (!overrun && !quiet) return null
  return { text: '', segments: segs ? [] : undefined, reason: `${suspect}:${overrun ? 'overrun' : 'no-speech-audio'}` }
}
