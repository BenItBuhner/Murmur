import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyLayout, splitUnits } from '../src/layout'
import { joinPieces } from '../src/seam'
import {
  cutPieces,
  loadLongSamples,
  oraclePlan,
  rng,
  scoreLayout,
  scoreSeams,
  type SeamScore
} from './long'

/**
 * Long dictations without a model (CI runs this; eval/long-live.test.ts asks a real one).
 *
 * Seams: each sample is cut into streamed pieces 200 ways (seeded): cuts on pauses mid-sentence
 * and at sentence ends, recognizer-style capitals and periods on every piece, a few forced cuts
 * that repeat words. The pieces are joined as the apps join them, and the result is scored
 * against what was said. Writes eval/last-long.json.
 */

const samples = loadLongSamples()
const TRIALS = 200

interface Totals {
  words: number
  seams: number
  wordErrors: number
  falseBreaks: number
  missedBreaks: number
  falseCaps: number
}

function total(join: (pieces: string[]) => string): Totals {
  const t: Totals = {
    words: 0,
    seams: 0,
    wordErrors: 0,
    falseBreaks: 0,
    missedBreaks: 0,
    falseCaps: 0
  }
  for (const s of samples)
    for (let k = 0; k < TRIALS; k++) {
      const pieces = cutPieces(s.spoken, rng(k * 7919 + s.id.length))
      const sc: SeamScore = scoreSeams(s.spoken, join(pieces))
      t.words += sc.words
      t.seams += pieces.length - 1
      t.wordErrors += Math.round(sc.wer * sc.words)
      t.falseBreaks += sc.falseBreaks
      t.missedBreaks += sc.missedBreaks
      t.falseCaps += sc.falseCaps
    }
  return t
}

const perSeam = (t: Totals): Record<string, number> => ({
  seams: t.seams,
  wer: +((100 * t.wordErrors) / t.words).toFixed(2),
  falseBreaksPerSeam: +(t.falseBreaks / t.seams).toFixed(3),
  missedBreaksPerSeam: +(t.missedBreaks / t.seams).toFixed(3),
  falseCapsPerSeam: +(t.falseCaps / t.seams).toFixed(3)
})

describe('long dictations (offline)', () => {
  it('has samples that parse, each long enough to be laid out', () => {
    expect(samples.length).toBeGreaterThanOrEqual(5)
    for (const s of samples) expect(s.spoken.split(/\s+/).length).toBeGreaterThanOrEqual(150)
  })

  it('joins streamed pieces with fewer broken sentences than a plain join, without losing words', () => {
    const plain = perSeam(total((p) => p.join(' ')))
    const joined = perSeam(total((p) => joinPieces(p).text))
    const report = { trials: TRIALS, samples: samples.map((s) => s.id), plain, joinPieces: joined }
    writeFileSync(resolve(import.meta.dirname, 'last-long.json'), JSON.stringify(report, null, 2))
    // Plain joining keeps every cut's period and capital. From the words alone the repair cannot
    // tell "on the beta. | Channel since then" from a real sentence end, so these are floors that
    // catch a regression, not targets: the formatter, which sees the piece before, does the rest.
    expect(joined.falseBreaksPerSeam).toBeLessThan(plain.falseBreaksPerSeam * 0.8)
    expect(joined.falseCapsPerSeam).toBeLessThan(plain.falseCapsPerSeam * 0.6)
    // The overlap a forced cut repeats is removed; nothing the speaker said is.
    expect(joined.wer).toBeLessThan(plain.wer)
    expect(joined.wer).toBeLessThan(0.5)
    // Repair must not glue real sentences together.
    expect(joined.missedBreaksPerSeam).toBeLessThan(0.05)
  })

  for (const s of samples)
    it(`${s.id}: a perfect layout plan gives every paragraph and list item, and keeps the words`, () => {
      const units = splitUnits(s.spoken)
      expect(units.length).toBe(s.sentences.length)
      const laid = applyLayout(units, oraclePlan(s))
      const sc = scoreLayout(s, laid)
      expect(sc.paragraphs.matched).toBe(sc.paragraphs.expected)
      expect(sc.items.matched).toBe(sc.items.expected)
      expect(sc.items.found).toBe(sc.items.expected)
      // Only the spoken cues an item opens with are dropped.
      expect(scoreSeams(s.spoken, laid).wer).toBeLessThan(0.03)
    })
})
