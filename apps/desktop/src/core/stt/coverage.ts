import { rmsDb } from '@core/audio/vad'
import { encodeWavPcm16 } from '@core/audio/wav'
import { countWords } from '@core/text/util'
import type { TimedSpan, TranscribeOutput } from './types'

/**
 * Does the transcript account for the whole clip?
 *
 * Whisper-style decoders sometimes emit end-of-text long before the speech ends and the API
 * returns that partial transcript as if it were complete. The classic trigger is the vocabulary
 * prompt: the model reads the prompt as the previous segment, and when the speaker then says the
 * term that closed the prompt it copies what followed it in context — nothing — and stops right
 * there. The word timings say where it stopped, so the rest can be transcribed from that point.
 */

export interface Coverage {
  /** End of the last timed word/segment, in seconds; null when the provider sent no timings. */
  transcribedSec: number | null
  /** Speech the transcript does not account for, in seconds (an estimate without timings). */
  missingSec: number
  truncated: boolean
  reason?: 'timestamps' | 'rate' | 'empty'
}

export interface CoverageOptions {
  /** Seconds the transcript may end before the speech does; timing jitter, a trailing pause. */
  slackSec?: number
  /** ...and at least this share of the speech must be missing. */
  minMissingRatio?: number
  /** Without timings: a transcript this sparse (words per second of speech) looks cut off. */
  minWordsPerSec?: number
  /** Without timings: only judge the word rate on clips at least this long. */
  minSpeechSecForRate?: number
}

export function assessCoverage(
  out: Pick<TranscribeOutput, 'text' | 'spans'>,
  speechEndSec: number,
  opts: CoverageOptions = {}
): Coverage {
  const slack = opts.slackSec ?? 2.5
  const ratio = opts.minMissingRatio ?? 0.08
  if (!Number.isFinite(speechEndSec) || speechEndSec <= 0)
    return { transcribedSec: null, missingSec: 0, truncated: false }
  const words = countWords(out.text)
  if (!words) {
    const truncated = speechEndSec >= 3
    return {
      transcribedSec: 0,
      missingSec: speechEndSec,
      truncated,
      reason: truncated ? 'empty' : undefined
    }
  }
  const ends = (out.spans ?? []).map((s) => s.end).filter((e) => Number.isFinite(e) && e >= 0)
  if (ends.length) {
    const last = Math.max(...ends)
    const missing = Math.max(0, speechEndSec - last)
    const truncated = missing > slack && missing > ratio * speechEndSec
    return {
      transcribedSec: last,
      missingSec: missing,
      truncated,
      reason: truncated ? 'timestamps' : undefined
    }
  }
  const minRate = opts.minWordsPerSec ?? 0.8
  const minSpeech = opts.minSpeechSecForRate ?? 8
  if (speechEndSec >= minSpeech && words / speechEndSec < minRate) {
    return {
      transcribedSec: null,
      missingSec: Math.max(0, speechEndSec - words / 2.5),
      truncated: true,
      reason: 'rate'
    }
  }
  return { transcribedSec: null, missingSec: 0, truncated: false }
}

export interface CutOptions {
  thresholdDb: number
  /** How far before the target a pause may start; a little overlap is repaired by the merge. */
  beforeSec?: number
  /** How far after the target to look for a pause before giving up and cutting at the target. */
  afterSec?: number
  frameMs?: number
}

/**
 * Where to split the audio when resuming after `targetSec`: the middle of the longest pause near
 * the target, so no word is cut in half. Falls back to just before the target.
 */
export function findCutPoint(
  pcm: Int16Array,
  sampleRate: number,
  targetSec: number,
  opts: CutOptions
): number {
  const frameMs = opts.frameMs ?? 20
  const frameLen = Math.max(1, Math.floor((sampleRate * frameMs) / 1000))
  const totalSec = pcm.length / sampleRate
  const from = Math.max(0, targetSec - (opts.beforeSec ?? 0.35))
  const to = Math.min(totalSec, targetSec + (opts.afterSec ?? 1.5))
  const f0 = Math.floor((from * sampleRate) / frameLen)
  const f1 = Math.floor((to * sampleRate) / frameLen)
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let f = f0; f < f1; f++) {
    const end = Math.min(pcm.length, (f + 1) * frameLen)
    if (rmsDb(pcm, f * frameLen, end) < opts.thresholdDb) {
      if (runStart < 0) runStart = f
      runLen++
      if (runLen > bestLen) {
        bestLen = runLen
        bestStart = runStart
      }
    } else {
      runStart = -1
      runLen = 0
    }
  }
  if (bestLen >= 2) return ((bestStart + bestLen / 2) * frameLen) / sampleRate
  return Math.max(0, Math.min(totalSec, targetSec - 0.1))
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

function wordsOf(s: string): Array<{ key: string; end: number }> {
  const out: Array<{ key: string; end: number }> = []
  for (const m of s.matchAll(WORD_RE))
    out.push({ key: m[0].toLowerCase().replace(/’/g, "'"), end: m.index + m[0].length })
  return out
}

/**
 * Append a resumed tail to the transcript so far. The cut sits in a pause, but the tail may still
 * repeat the last word or two of the head; a matching run at the seam is dropped from the tail.
 */
export function mergeTranscripts(head: string, tail: string): string {
  const h = head.trim()
  const t = tail.trim()
  if (!t) return h
  if (!h) return t
  const hw = wordsOf(h).slice(-8)
  const tw = wordsOf(t).slice(0, 8)
  let overlap = 0
  for (let k = Math.min(hw.length, tw.length); k >= 1; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) same = hw[hw.length - k + i].key === tw[i].key
    // A single shared short word ("the") is more likely coincidence than overlap.
    if (same && (k >= 2 || tw[0].key.length >= 5)) {
      overlap = k
      break
    }
  }
  const rest = overlap ? t.slice(tw[overlap - 1].end).replace(/^[\s,;:.!?…-]+/u, '') : t
  if (!rest) return h
  return `${h} ${rest}`
}

export interface CompleteOptions {
  pcm: Int16Array
  sampleRate: number
  /** Where the speech ends in `pcm`, from voice activity detection. */
  speechEndSec: number
  /** VAD threshold used to find pauses to cut at. */
  thresholdDb: number
  /** Prompt for the first attempt; may carry the vocabulary. */
  prompt?: string
  /**
   * Prompt for resumed tails. Must not end with anything the speaker might say, so it never
   * re-creates the early stop it is recovering from; a plain style hint or nothing.
   */
  tailPrompt?: string
  maxRounds?: number
  coverage?: CoverageOptions
  log?: (message: string) => void
}

export interface CompleteResult extends TranscribeOutput {
  /** Extra requests made to recover text the first transcript stopped short of. */
  resumed: number
  /** Seconds of speech the recovery added to the transcript. */
  recoveredSec: number
  coverage: Coverage
}

export type Transcribe = (wav: Uint8Array, prompt: string | undefined) => Promise<TranscribeOutput>

/**
 * Transcribe the clip and keep going until the transcript reaches the end of the speech. With
 * timings, only the audio after the point where the transcript stopped is sent again (starting in
 * a pause, without the vocabulary prompt) and appended. Without timings there is nowhere to
 * resume from, so a suspiciously sparse transcript is retried whole without the prompt and the
 * fuller answer wins. Recovery failures are logged and never lose the text already obtained.
 */
export async function transcribeComplete(
  transcribe: Transcribe,
  opts: CompleteOptions
): Promise<CompleteResult> {
  const { pcm, sampleRate, speechEndSec } = opts
  const log = opts.log ?? ((): void => undefined)
  const fmt = (n: number): string => n.toFixed(1)
  let out = await transcribe(encodeWavPcm16(pcm, sampleRate), opts.prompt)
  let resumed = 0
  let recoveredSec = 0
  let cov = assessCoverage(out, speechEndSec, opts.coverage)
  if (!cov.truncated) return { ...out, resumed, recoveredSec, coverage: cov }

  if (cov.transcribedSec === null) {
    if (opts.prompt !== undefined && opts.prompt !== opts.tailPrompt) {
      log(
        `transcript has ${countWords(out.text)} words for ${fmt(speechEndSec)}s of speech and no timings; retrying without the vocabulary prompt`
      )
      try {
        const retry = await transcribe(encodeWavPcm16(pcm, sampleRate), opts.tailPrompt)
        if (countWords(retry.text) > countWords(out.text) * 1.25) {
          out = { ...retry, latencyMs: out.latencyMs + retry.latencyMs }
          resumed = 1
          cov = assessCoverage(out, speechEndSec, opts.coverage)
        }
      } catch (err) {
        log(`retry without prompt failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { ...out, resumed, recoveredSec, coverage: cov }
  }

  const maxRounds = opts.maxRounds ?? 3
  for (let round = 0; round < maxRounds && cov.truncated && cov.transcribedSec !== null; round++) {
    const stoppedAt = cov.transcribedSec
    const cut = findCutPoint(pcm, sampleRate, stoppedAt, { thresholdDb: opts.thresholdDb })
    if (speechEndSec - cut < 0.6 || pcm.length / sampleRate - cut < 0.5) break
    log(
      `transcript stops at ${fmt(stoppedAt)}s of ${fmt(speechEndSec)}s of speech; resuming from ${fmt(cut)}s`
    )
    let tail: TranscribeOutput
    try {
      tail = await transcribe(
        encodeWavPcm16(pcm.subarray(Math.floor(cut * sampleRate)), sampleRate),
        opts.tailPrompt
      )
    } catch (err) {
      log(`resume failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
    const tailText = tail.text.trim()
    if (!tailText) break
    const shifted: TimedSpan[] = (tail.spans ?? []).map((s) => ({
      start: s.start + cut,
      end: s.end + cut
    }))
    out = {
      ...out,
      text: mergeTranscripts(out.text, tailText),
      spans: [...(out.spans ?? []), ...shifted],
      latencyMs: out.latencyMs + tail.latencyMs
    }
    resumed++
    cov = assessCoverage(out, speechEndSec, opts.coverage)
    const reached = cov.transcribedSec ?? stoppedAt
    recoveredSec += Math.max(0, reached - stoppedAt)
    // The tail came back without timings, or did not move the end: nothing more to learn here.
    if (reached <= stoppedAt + 0.5) break
  }
  return { ...out, resumed, recoveredSec, coverage: cov }
}
