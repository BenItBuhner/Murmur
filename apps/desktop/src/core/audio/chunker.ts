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
  /** Without a pause, a piece is cut at the quietest frame by this length. */
  maxSec: number
  /** A pause at least this long is a clean cut point. */
  pauseMs: number
}

export const DEFAULT_CHUNK_PLAN: ChunkPlan = { minSec: 15, maxSec: 28, pauseMs: 300 }

const FRAME_MS = 20

/**
 * The sample index to cut at in `pcm` (audio from the last cut on), or null to keep listening.
 * Cuts land in the middle of the first pause of `pauseMs` below `thresholdDb` after `minSec`;
 * at `maxSec` with no pause, at the quietest frame between the two.
 */
export function findCut(
  pcm: Int16Array,
  sampleRate: number,
  thresholdDb: number,
  plan: ChunkPlan = DEFAULT_CHUNK_PLAN
): number | null {
  const frame = Math.floor((sampleRate * FRAME_MS) / 1000)
  const from = Math.floor(plan.minSec * sampleRate)
  if (pcm.length < from + frame) return null
  const need = Math.ceil(plan.pauseMs / FRAME_MS)
  const limit = Math.min(pcm.length, Math.floor(plan.maxSec * sampleRate))
  let run = 0
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
      if (run >= need) return at + frame - Math.floor((run * frame) / 2)
    } else run = 0
  }
  if (pcm.length >= Math.floor(plan.maxSec * sampleRate) && quietest >= 0)
    return quietest + Math.floor(frame / 2)
  return null
}
