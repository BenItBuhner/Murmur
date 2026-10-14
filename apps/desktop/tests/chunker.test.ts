import { describe, expect, it } from 'vitest'
import { findCut, findCutDetail } from '@core/audio/chunker'
import { ChunkStreamer, PAUSE_LEAD_IN_SEC } from '../src/main/dictation/streaming'

const RATE = 16000
const loud = (s: number): Int16Array => {
  const p = new Int16Array(Math.round(s * RATE))
  for (let i = 0; i < p.length; i++) p[i] = Math.round(Math.sin(i / 9) * 9000)
  return p
}
const gap = (p: Int16Array, from: number, to: number): Int16Array => {
  p.fill(0, Math.round(from * RATE), Math.round(to * RATE))
  return p
}

describe('findCut', () => {
  it('waits until the minimum length', () => {
    expect(findCut(loud(15), RATE, -30)).toBeNull()
  })
  it('cuts in the middle of the first long pause after the minimum', () => {
    const p = gap(loud(22), 19, 19.9)
    const cut = findCutDetail(p, RATE, -30)!
    expect(cut.at / RATE).toBeGreaterThan(19.2)
    expect(cut.at / RATE).toBeLessThan(19.7)
    expect(cut.forced).toBe(false)
  })
  it('does not cut at a breath-length pause before the maximum', () => {
    // A mid-sentence breath like the one that split "would otherwise | be picked up".
    const p = gap(loud(25), 20, 20.35)
    expect(findCut(p, RATE, -30)).toBeNull()
  })
  it('ignores pauses before the minimum and keeps listening without one', () => {
    const p = gap(loud(25), 5, 6)
    expect(findCut(p, RATE, -30)).toBeNull()
  })
  it('at the maximum, takes the longest pause seen', () => {
    const p = gap(gap(loud(30), 20, 20.3), 26, 26.5)
    const cut = findCutDetail(p, RATE, -30)!
    expect(Math.abs(cut.at / RATE - 26.25)).toBeLessThan(0.05)
    expect(cut.pauseMs).toBeGreaterThanOrEqual(480)
    expect(cut.forced).toBe(false)
  })
  it('at the maximum with no pause, cuts at the quietest frame and flags it', () => {
    const p = loud(30)
    for (let i = 22 * RATE; i < 22 * RATE + 320; i++) p[i] = 10
    const cut = findCutDetail(p, RATE, -60)!
    expect(Math.abs(cut.at / RATE - 22)).toBeLessThan(0.05)
    expect(cut.forced).toBe(true)
  })
})

describe('ChunkStreamer overlap', () => {
  const run = async (pcm: Int16Array): Promise<{ sizes: number[]; samples: number }> => {
    const sizes: number[] = []
    let fed = 0
    const s = new ChunkStreamer(
      (from) => pcm.slice(from, fed),
      async (piece) => {
        sizes.push(piece.length)
        return ''
      },
      RATE,
      -30
    )
    while (fed < pcm.length) {
      fed = Math.min(pcm.length, fed + 1600)
      s.onSamples(fed)
    }
    const done = s.finish()
    await done.texts
    return { sizes, samples: done.samples }
  }
  it('starts inside the pause after a clean cut', async () => {
    const pcm = gap(gap(loud(50), 20, 21), 40, 41)
    const { sizes, samples } = await run(pcm)
    expect(sizes.length).toBe(2)
    expect(sizes[0] + sizes[1] - samples).toBe(2 * PAUSE_LEAD_IN_SEC * RATE)
  })
})
