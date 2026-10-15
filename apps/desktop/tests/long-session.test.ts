import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHUNK_PLAN } from '@core/audio/chunker'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined })
}))

import {
  ChunkStreamer,
  FORMAT_GROUP_WORDS,
  LONG_CLIP_SEC,
  MAX_PIECES_IN_FLIGHT,
  formatGroups,
  limiter,
  transcribeInPieces
} from '../src/main/dictation/streaming'
import { PartialStore, RECOVERED_NOTE, recoveredEntry } from '../src/main/store/partials'

const RATE = 16000
const MINUTES = 30

/**
 * Thirty minutes of "speech": tone bursts of 2-7 s with 0.25-1.2 s pauses between them, the
 * pattern deterministic. 28.8 M samples (~58 MB), the size a real 30-minute session holds.
 */
function speech(minutes: number): Int16Array {
  const pcm = new Int16Array(minutes * 60 * RATE)
  let at = 0
  let k = 0
  while (at < pcm.length) {
    const burst = Math.round((2 + ((k * 37) % 50) / 10) * RATE)
    for (let i = at; i < Math.min(pcm.length, at + burst); i++) pcm[i] = Math.round(Math.sin(i / 9) * 9000)
    at += burst + Math.round((0.25 + ((k * 13) % 10) / 10) * RATE)
    k++
  }
  return pcm
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a simulated 30-minute dictation', () => {
  it('streams in bounded pieces, never more than MAX_PIECES_IN_FLIGHT requests at once, and retries a failed piece', async () => {
    const pcm = speech(MINUTES)
    let active = 0
    let peak = 0
    const calls: number[] = []
    const failedOnce = new Set<number>()
    const transcribe = async (piece: Int16Array, index: number): Promise<string> => {
      active++
      peak = Math.max(peak, active)
      calls.push(index)
      // Slow network: each request takes longer than the audio arrives in this test.
      await sleep(2)
      active--
      // Piece 7 fails the first time (a dropped connection); its retry answers.
      if (index === 7 && !failedOnce.has(7)) {
        failedOnce.add(7)
        throw new Error('connection reset')
      }
      expect(piece.length / RATE).toBeLessThanOrEqual(DEFAULT_CHUNK_PLAN.maxSec + 1.01)
      return `piece ${index}.`
    }
    let total = 0
    const streamer = new ChunkStreamer((from) => pcm.subarray(from, total), transcribe, RATE, -60)
    // The recorder delivers 100 ms frames; the session calls onSamples on each.
    const frame = RATE / 10
    for (total = frame; total <= pcm.length; total += frame) streamer.onSamples(total)
    const done = streamer.finish()
    const texts = await done.texts
    expect(texts.length).toBeGreaterThanOrEqual((MINUTES * 60) / DEFAULT_CHUNK_PLAN.maxSec)
    expect(texts.length).toBeLessThanOrEqual((MINUTES * 60) / DEFAULT_CHUNK_PLAN.minSec + 1)
    expect(texts[7]).toBe('piece 7.')
    expect(calls.filter((i) => i === 7)).toHaveLength(2)
    expect(peak).toBeLessThanOrEqual(MAX_PIECES_IN_FLIGHT)
    // What is left for the release is under one piece.
    expect((pcm.length - done.samples) / RATE).toBeLessThan(DEFAULT_CHUNK_PLAN.maxSec + 2)
  }, 60_000)

  it('a long recording sent again (fallback or Retry) goes up in pieces under the gateway clip cap, a few at a time', async () => {
    const pcm = speech(MINUTES)
    let active = 0
    let peak = 0
    let longest = 0
    const texts = await transcribeInPieces(pcm, RATE, -60, async (clip, i) => {
      active++
      peak = Math.max(peak, active)
      longest = Math.max(longest, clip.length / RATE)
      await sleep(1)
      active--
      return `t${i}`
    })
    expect(longest).toBeLessThanOrEqual(LONG_CLIP_SEC)
    expect(longest).toBeLessThanOrEqual(DEFAULT_CHUNK_PLAN.maxSec + 1.01)
    expect(peak).toBeLessThanOrEqual(MAX_PIECES_IN_FLIGHT)
    expect(texts.length).toBeGreaterThan(50)
  }, 60_000)

  it('a long transcript is formatted in groups of about FORMAT_GROUP_WORDS words cut at sentence ends', () => {
    const sentence = 'This is one sentence of a long dictation that keeps going on.'
    const text = Array.from({ length: 400 }, () => sentence).join(' ') // 4,800 words
    const groups = formatGroups(text)
    expect(groups.join(' ')).toBe(text)
    for (const g of groups) {
      expect(g.endsWith('.')).toBe(true)
      expect(g.split(/\s+/).length).toBeLessThanOrEqual(FORMAT_GROUP_WORDS + 12)
    }
    expect(groups.length).toBeGreaterThanOrEqual(19)
  })

  it('limiter runs tasks in order, at most N at a time', async () => {
    const run = limiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(async () => {
          active++
          peak = Math.max(peak, active)
          order.push(i)
          await sleep(1)
          active--
        })
      )
    )
    expect(peak).toBe(2)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('crash recovery of a partial transcript', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('keeps streamed pieces on disk, and turns what a crash left into a History entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'murmur-partials-'))
    const store = new PartialStore(dir)
    store.save({ id: 'a1', createdAt: 1, mode: 'hold', texts: ['First part of it.', null, 'third part.'] })
    store.save({ id: 'b2', createdAt: 2, mode: 'hands-free', texts: ['done'] })
    store.clear('b2') // finished normally
    store.save({ id: 'c3', createdAt: 3, mode: 'hold', texts: [] }) // nothing came back yet
    const left = new PartialStore(dir).takeAll()
    expect(left.map((p) => p.id)).toEqual(['a1', 'c3'])
    expect(new PartialStore(dir).takeAll()).toEqual([])
    const entry = recoveredEntry(left[0])!
    expect(entry.finalText).toBe('First part of it third part.') // the seam join: a lowercase continuation
    expect(entry.error).toBe(RECOVERED_NOTE)
    expect(entry.stages).toEqual(['recovered'])
    expect(recoveredEntry(left[1])).toBeNull()
  })
})
