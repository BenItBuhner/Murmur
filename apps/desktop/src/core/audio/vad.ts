/**
 * Lightweight energy-based voice activity detection. Purpose-built for two jobs:
 *  1. Skip the network round-trip entirely when the user pressed the key but said nothing
 *     (Whisper hallucinates on silence, so this also avoids junk text).
 *  2. Trim leading/trailing silence so uploads are smaller and decoding is faster.
 */

export function rmsDb(frame: Int16Array, start = 0, end = frame.length): number {
  let sum = 0
  const n = Math.max(1, end - start)
  for (let i = start; i < end; i++) {
    const s = frame[i] / 32768
    sum += s * s
  }
  const rms = Math.sqrt(sum / n)
  return rms <= 1e-9 ? -100 : 20 * Math.log10(rms)
}

/**
 * Each frame's level in dB (20 ms frames by default). A long recording is analyzed several times
 * at release (threshold, speech, trim); computed once here, those passes share it.
 */
export function frameLevelsDb(pcm: Int16Array, sampleRate: number, frameMs = 20): Float64Array {
  const frameLen = Math.max(1, Math.floor((sampleRate * frameMs) / 1000))
  const frames = Math.floor(pcm.length / frameLen)
  const levels = new Float64Array(frames)
  for (let f = 0; f < frames; f++) levels[f] = rmsDb(pcm, f * frameLen, (f + 1) * frameLen)
  return levels
}

export interface VadOptions {
  sampleRate: number
  thresholdDb: number
  frameMs?: number
  /** Silence kept around detected speech so words are not clipped. */
  paddingMs?: number
  /** Minimum voiced time to consider the clip to contain speech. */
  minSpeechMs?: number
  /** `frameLevelsDb(pcm, sampleRate, frameMs)` of this same audio, when already computed. */
  levels?: Float64Array
}

export interface VadResult {
  hasSpeech: boolean
  speechMs: number
  firstVoicedMs: number
  lastVoicedMs: number
  peakDb: number
}

export function analyze(pcm: Int16Array, opts: VadOptions): VadResult {
  const frameMs = opts.frameMs ?? 20
  const frameLen = Math.max(1, Math.floor((opts.sampleRate * frameMs) / 1000))
  const minSpeechMs = opts.minSpeechMs ?? 200
  let voicedFrames = 0
  let first = -1
  let last = -1
  let peak = -100
  const frames = Math.floor(pcm.length / frameLen)
  const levels = opts.levels?.length === frames ? opts.levels : null
  for (let f = 0; f < frames; f++) {
    const db = levels ? levels[f] : rmsDb(pcm, f * frameLen, (f + 1) * frameLen)
    if (db > peak) peak = db
    if (db >= opts.thresholdDb) {
      voicedFrames++
      if (first < 0) first = f
      last = f
    }
  }
  const speechMs = voicedFrames * frameMs
  return {
    hasSpeech: speechMs >= minSpeechMs,
    speechMs,
    firstVoicedMs: first < 0 ? -1 : first * frameMs,
    lastVoicedMs: last < 0 ? -1 : (last + 1) * frameMs,
    peakDb: peak
  }
}

export interface TrimResult {
  pcm: Int16Array
  trimmedStartMs: number
  trimmedEndMs: number
  analysis: VadResult
}

export function trimSilence(pcm: Int16Array, opts: VadOptions): TrimResult {
  const analysis = analyze(pcm, opts)
  if (!analysis.hasSpeech || analysis.firstVoicedMs < 0) {
    return { pcm, trimmedStartMs: 0, trimmedEndMs: 0, analysis }
  }
  const padding = opts.paddingMs ?? 250
  const toSamples = (ms: number): number => Math.floor((ms * opts.sampleRate) / 1000)
  const start = Math.max(0, toSamples(analysis.firstVoicedMs - padding))
  const end = Math.min(pcm.length, toSamples(analysis.lastVoicedMs + padding))
  const totalMs = (pcm.length / opts.sampleRate) * 1000
  return {
    pcm: pcm.subarray(start, end),
    trimmedStartMs: (start / opts.sampleRate) * 1000,
    trimmedEndMs: totalMs - (end / opts.sampleRate) * 1000,
    analysis
  }
}

/** Adaptive threshold: noise floor estimate + margin, clamped to the configured value. */
export function adaptiveThreshold(
  pcm: Int16Array,
  sampleRate: number,
  configuredDb: number,
  levels?: Float64Array
): number {
  const frameLen = Math.floor((sampleRate * 20) / 1000)
  const frames = Math.floor(pcm.length / frameLen)
  if (frames < 10) return configuredDb
  // A copy: the caller's levels stay in time order for the passes after this one.
  const sorted =
    levels?.length === frames ? Float64Array.from(levels) : frameLevelsDb(pcm, sampleRate)
  sorted.sort()
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)]
  // Speech is normally >12 dB above the floor; never go below what the user configured.
  return Math.max(configuredDb, noiseFloor + 12)
}

/**
 * Milliseconds of pitched sound (voiced speech: a vowel, a hum) between `startSec` and `endSec`.
 * A 20 ms frame counts when it is above the floor and repeats itself at a pitch period between
 * 2.5 and 12.5 ms (80-400 Hz) with normalized autocorrelation of at least 0.5. Breath, a rustle, a
 * click or a key press have energy but no pitch, so they count for nothing; "thank you" said
 * aloud has a few hundred ms of it.
 */
export function pitchedMs(
  pcm: Int16Array,
  sampleRate: number,
  startSec = 0,
  endSec = pcm.length / sampleRate,
  floorDb = -50
): number {
  const frame = Math.floor(sampleRate * 0.02)
  const minLag = Math.floor(sampleRate / 400)
  const maxLag = Math.floor(sampleRate / 80)
  const from = Math.max(0, Math.floor(startSec * sampleRate))
  const to = Math.min(pcm.length, Math.floor(endSec * sampleRate))
  let ms = 0
  for (let s = from; s + frame + maxLag <= to; s += frame) {
    if (rmsDb(pcm, s, s + frame + maxLag) < floorDb) continue
    let best = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let xy = 0
      let xx = 0
      let yy = 0
      for (let i = s; i < s + frame; i++) {
        const x = pcm[i]
        const y = pcm[i + lag]
        xy += x * y
        xx += x * x
        yy += y * y
      }
      const r = xx && yy ? xy / Math.sqrt(xx * yy) : 0
      if (r > best) best = r
    }
    if (best >= 0.5) ms += 20
  }
  return ms
}
