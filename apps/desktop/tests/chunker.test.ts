import { describe, expect, it } from 'vitest'
import { findCut } from '@core/audio/chunker'

const RATE = 16000
const loud = (s: number): Int16Array => {
  const p = new Int16Array(Math.round(s * RATE))
  for (let i = 0; i < p.length; i++) p[i] = Math.round(Math.sin(i / 9) * 9000)
  return p
}

describe('findCut', () => {
  it('waits until the minimum length', () => {
    expect(findCut(loud(10), RATE, -30)).toBeNull()
  })
  it('cuts in the middle of the first pause after the minimum', () => {
    const p = loud(20)
    p.fill(0, 16 * RATE, Math.round(16.6 * RATE))
    const cut = findCut(p, RATE, -30)!
    expect(cut / RATE).toBeGreaterThan(16)
    expect(cut / RATE).toBeLessThan(16.6)
  })
  it('ignores pauses before the minimum and keeps listening without one', () => {
    const p = loud(20)
    p.fill(0, 5 * RATE, 6 * RATE)
    expect(findCut(p, RATE, -30)).toBeNull()
  })
  it('at the maximum, cuts at the quietest frame', () => {
    const p = loud(30)
    for (let i = 22 * RATE; i < 22 * RATE + 320; i++) p[i] = 10
    const cut = findCut(p, RATE, -60)!
    expect(Math.abs(cut / RATE - 22)).toBeLessThan(0.05)
  })
})
