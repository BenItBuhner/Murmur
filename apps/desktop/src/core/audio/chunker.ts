import { rmsDb } from './vad'

/**
 * Where to cut a long dictation while it is still being spoken, so finished stretches can be
 * transcribed in parallel with the speech that follows. Bench (Oct 2026, 2-5 min clips): 15 s
 * pieces sent during recording leave ~0.25 s of speech recognition after the key is released,
 * whatever the length, with the same word error rate as one upload.
 */
export interface ChunkPlan {
  /** A piece is cut once at least this much new audio is waiting. */
  minSec: number
  /** Without a clean pause, a piece is cut by this length at the longest pause seen. */
  maxSec: number
  /** A pause at least this long is a clean cut point (a sentence end, not a breath). */
  pauseMs: number
  /** At `maxSec`, a pause at least this long still beats cutting through speech. */
  fallbackPauseMs: number
}

/**
 * Oct 2026: 300 ms pauses cut mid-sentence (a breath before "be picked up"), and each piece came
 * back as its own sentence. Only pauses of 700 ms and more are taken now; pieces may run to 30 s.
 * Release latency grows a little (a longer tail), which Bennett prefers to broken sentences.
 */
export const DEFAULT_CHUNK_PLAN: ChunkPlan = {
  minSec: 18,
  maxSec: 30,
  pauseMs: 700,
  fallbackPauseMs: 240
}

const FRAME_MS = 20

export interface Cut {
  /** Sample index of the cut in the audio passed in. */
  at: number
  /** Length of the pause the cut sits in, in ms (0 when it cuts through sound). */
  pauseMs: number
  /** No usable pause: the cut may split a word, so the next piece should overlap it. */
  forced: boolean
}

/**
 * Where to cut `pcm` (audio from the last cut on), or null to keep listening. Cuts land in the
 * middle of the first pause of `pauseMs` below `thresholdDb` after `minSec`. At `maxSec` with no
 * such pause: the middle of the longest pause seen, if at least `fallbackPauseMs`, else the
 * quietest frame (forced).
 */
export function findCutDetail(
  pcm: Int16Array,
  sampleRate: number,
  thresholdDb: number,
  plan: ChunkPlan = DEFAULT_CHUNK_PLAN
): Cut | null {
  const frame = Math.floor((sampleRate * FRAME_MS) / 1000)
  const from = Math.floor(plan.minSec * sampleRate)
  if (pcm.length < from + frame) return null
  const need = Math.ceil(plan.pauseMs / FRAME_MS)
  const maxAt = Math.floor(plan.maxSec * sampleRate)
  const limit = Math.min(pcm.length, maxAt)
  let run = 0
  let best = 0
  let bestEnd = -1
  let quietest = -1
  let quietestDb = Infinity
  for (let at = from; at + frame <= limit; at += frame) {
    const db = rmsDb(pcm, at, at + frame)
    if (db < quietestDb) {
      quietestDb = db
      quietest = at
    }
    if (db < thresholdDb) {
      run++
      if (run > best) {
        best = run
        bestEnd = at + frame
      }
      if (run >= need)
        return {
          at: at + frame - Math.floor((run * frame) / 2),
          pauseMs: run * FRAME_MS,
          forced: false
        }
    } else run = 0
  }
  if (pcm.length < maxAt) return null
  if (best * FRAME_MS >= plan.fallbackPauseMs)
    return { at: bestEnd - Math.floor((best * frame) / 2), pauseMs: best * FRAME_MS, forced: false }
  if (quietest < 0) return null
  return { at: quietest + Math.floor(frame / 2), pauseMs: 0, forced: true }
}

/** findCutDetail, the sample index only. */
export function findCut(
  pcm: Int16Array,
  sampleRate: number,
  thresholdDb: number,
  plan: ChunkPlan = DEFAULT_CHUNK_PLAN
): number | null {
  return findCutDetail(pcm, sampleRate, thresholdDb, plan)?.at ?? null
}

/**
 * Speculating on the tail: the last pause of at least `minPauseMs` in `pcm` (the audio since the
 * last cut) that ends at least `minSec` in, or null. The audio up to its middle can be transcribed
 * and formatted while the user is still talking, so release only waits for what follows it.
 */
export function findSpecCut(
  pcm: Int16Array,
  sampleRate: number,
  thresholdDb: number,
  minPauseMs = 400,
  minSec = 2
): Cut | null {
  const frame = Math.floor((sampleRate * FRAME_MS) / 1000)
  const need = Math.ceil(minPauseMs / FRAME_MS)
  const from = Math.floor(minSec * sampleRate)
  let run = 0
  let best: Cut | null = null
  for (let at = 0; at + frame <= pcm.length; at += frame) {
    if (rmsDb(pcm, at, at + frame) < thresholdDb) {
      run++
      continue
    }
    if (run >= need && at >= from)
      best = { at: at - Math.floor((run * frame) / 2), pauseMs: run * FRAME_MS, forced: false }
    run = 0
  }
  return best
}
