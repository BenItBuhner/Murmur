import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../src/format'
import { prepareTranscript } from '../src/cleanup'
import { verifyOutput } from '../src/verify'
import { contextOf, loadFixtures, scoreText } from './score'

/**
 * The corpus without a model: every fixture's `good` answer must pass the verifier and the
 * fixture's own expectations when it comes back from a (fake) model, and every `bad` answer must
 * be caught, so that the engine falls back instead of inserting it. This is what CI runs; the
 * live run (`MURMUR_LIVE=1`) asks a real model the same questions.
 */

const fixtures = loadFixtures()

describe('eval corpus (offline)', () => {
  it('has unique ids', () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
  })

  for (const f of fixtures) {
    describe(f.id, () => {
      it('accepts and scores the good answer', async () => {
        const result = await formatTranscript(
          { transcript: f.transcript, mode: 'smart', context: contextOf(f) },
          async () => ({ text: f.good })
        )
        expect(result.status.outcome, JSON.stringify(result.status)).toBe('used')
        const score = scoreText(f, result.text, result)
        expect(
          score.pass,
          score.checks
            .filter((c) => !c.pass)
            .map((c) => `${c.name} ${c.detail ?? ''}`)
            .join('; ')
        ).toBe(true)
      })

      for (const bad of f.bad) {
        it(`catches ${JSON.stringify(bad.slice(0, 50))}`, () => {
          const prepared = prepareTranscript(f.transcript).text
          const verdict = verifyOutput(prepared, bad)
          const score = scoreText(f, bad)
          // Either the verifier rejects it outright (and the engine falls back), or it fails the
          // fixture's expectations, which the live run reports as a model quality miss.
          expect(!verdict.ok || !score.pass, 'a bad answer slipped through both gates').toBe(true)
        })
      }
    })
  }

  it('the verifier alone catches every bad answer that changes a number or answers a question', () => {
    const mustCatch = fixtures.flatMap((f) =>
      f.bad
        .filter(
          () =>
            (f.id.startsWith('numbers/') && f.id !== 'numbers/counting') ||
            f.id === 'guard/question-stays-question'
        )
        .map((b) => [f, b] as const)
    )
    expect(mustCatch.length).toBeGreaterThan(10)
    for (const [f, bad] of mustCatch) {
      const verdict = verifyOutput(prepareTranscript(f.transcript).text, bad)
      expect(verdict.ok, `${f.id}: ${bad}`).toBe(false)
    }
  })
})
