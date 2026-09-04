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

export interface VadOptions {
  sampleRate: number
  thresholdDb: number
  frameMs?: number
  /** Silence kept around detected speech so words are not clipped. */
  paddingMs?: number
  /** Minimum voiced time to consider the clip to contain speech. */
  minSpeechMs?: number
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
  for (let f = 0; f < frames; f++) {
    const db = rmsDb(pcm, f * frameLen, (f + 1) * frameLen)
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
  configuredDb: number
): number {
  const frameLen = Math.floor((sampleRate * 20) / 1000)
  const frames = Math.floor(pcm.length / frameLen)
  if (frames < 10) return configuredDb
  const levels: number[] = []
  for (let f = 0; f < frames; f++) levels.push(rmsDb(pcm, f * frameLen, (f + 1) * frameLen))
  levels.sort((a, b) => a - b)
  const noiseFloor = levels[Math.floor(levels.length * 0.2)]
  // Speech is normally >12 dB above the floor; never go below what the user configured.
  return Math.max(configuredDb, noiseFloor + 12)
}
