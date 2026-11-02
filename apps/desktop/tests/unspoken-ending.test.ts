import { describe, expect, it } from 'vitest'
import { pitchedMs } from '@core/audio/vad'
import { dropUnspokenEnding } from '../src/main/dictation/unspoken'

const SR = 16000

/** A vowel-like sound: harmonics of a 140 Hz pitch. */
function voiced(sec: number): Int16Array {
  const out = new Int16Array(Math.round(sec * SR))
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    out[i] = Math.round(
      6000 * Math.sin(2 * Math.PI * 140 * t) +
        3000 * Math.sin(2 * Math.PI * 280 * t) +
        1500 * Math.sin(2 * Math.PI * 420 * t)
    )
  }
  return out
}

/** Breath or a rustle: loud noise with no pitch. */
function noise(sec: number, amp = 4000, seed = 1): Int16Array {
  let s = seed
  const out = new Int16Array(Math.round(sec * SR))
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = Math.round(((s / 0x7fffffff) * 2 - 1) * amp)
  }
  return out
}

const quiet = (sec: number): Int16Array => noise(sec, 20, 7)

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const answer = (
  text: string,
  words: Array<[string, number, number]>
): { text: string; latencyMs: number; resumed: number; raw: unknown } => ({
  text,
  latencyMs: 1,
  resumed: 0,
  raw: { words: words.map(([word, start, end]) => ({ word, start, end })) }
})

describe('pitched sound', () => {
  it('finds it in a vowel, not in noise or quiet', () => {
    expect(pitchedMs(voiced(0.4), SR)).toBeGreaterThanOrEqual(300)
    expect(pitchedMs(noise(0.6), SR)).toBeLessThan(40)
    expect(pitchedMs(quiet(0.6), SR)).toBe(0)
  })
})

describe('a stock phrase at the end of a transcript', () => {
  const words: Array<[string, number, number]> = [
    ['They', 0.1, 0.4],
    ['look', 0.4, 0.8],
    ['right.', 0.8, 1.6],
    ['Thank', 2.3, 2.55],
    ['you.', 2.55, 2.85]
  ]

  it('is dropped when there is no voice under it (a breath after the last word)', () => {
    const clip = concat(voiced(1.7), quiet(0.5), noise(0.7), quiet(0.3))
    const out = dropUnspokenEnding(answer('They look right. Thank you.', words), clip)
    expect(out.text).toBe('They look right.')
  })

  it('is kept when it was said', () => {
    const clip = concat(voiced(1.7), quiet(0.5), voiced(0.7), quiet(0.3))
    const out = dropUnspokenEnding(answer('They look right. Thank you.', words), clip)
    expect(out.text).toBe('They look right. Thank you.')
  })

  it('is left alone without word timings, after a resume, or when it is the whole transcript', () => {
    const clip = concat(voiced(1.7), quiet(0.5), noise(0.7), quiet(0.3))
    const plain = { text: 'They look right. Thank you.', latencyMs: 1 }
    expect(dropUnspokenEnding(plain, clip).text).toBe(plain.text)
    const resumed = { ...answer('They look right. Thank you.', words), resumed: 1 }
    expect(dropUnspokenEnding(resumed, clip).text).toBe(resumed.text)
    const only = answer('Thank you.', [
      ['Thank', 2.3, 2.55],
      ['you.', 2.55, 2.85]
    ])
    expect(dropUnspokenEnding(only, clip).text).toBe('Thank you.')
  })

  it('only ever touches a stock phrase', () => {
    const clip = concat(voiced(1.7), quiet(0.5), noise(0.7), quiet(0.3))
    const out = dropUnspokenEnding(
      answer('They look right. Ship it.', [
        ['They', 0.1, 0.4],
        ['look', 0.4, 0.8],
        ['right.', 0.8, 1.6],
        ['Ship', 2.3, 2.55],
        ['it.', 2.55, 2.85]
      ]),
      clip
    )
    expect(out.text).toBe('They look right. Ship it.')
  })
})
