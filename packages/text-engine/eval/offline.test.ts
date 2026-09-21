import { describe, expect, it } from 'vitest'
import { alreadyClean } from '../src/clean'
import { formatTranscript } from '../src/format'
import { prepareTranscript } from '../src/cleanup'
import { verifyOutput } from '../src/verify'
import { contextOf, loadFixtures, scoreText } from './score'

/**
 * The corpus without a model: every fixture's `good` answer must pass the verifier and the
 * fixture's own expectations when it comes back from a (fake) model, and every `bad` answer must
 * be caught, so that the engine falls back instead of inserting it. Fixtures marked `skipModel`
 * must never reach the model at all: their `good` is the rule-based text. This is what CI runs;
 * the live run (`MURMUR_LIVE=1`) asks a real model the same questions.
 */

const fixtures = loadFixtures()

describe('eval corpus (offline)', () => {
  it('has unique ids', () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
  })

  for (const f of fixtures) {
    describe(f.id, () => {
      it(f.expect.skipModel ? 'is finished by the rules alone' : 'accepts and scores the good answer', async () => {
        let calls = 0
        const result = await formatTranscript(
          { transcript: f.transcript, mode: 'smart', context: contextOf(f) },
          async () => {
            calls++
            return { text: f.good }
          }
        )
        if (f.expect.skipModel) {
          expect(result.status, JSON.stringify(result.status)).toEqual({
            outcome: 'skipped-clean',
            detail: 'already clean',
            attempts: 0
          })
          expect(calls).toBe(0)
          expect(result.text).toBe(f.good)
        } else {
          expect(result.status.outcome, JSON.stringify(result.status)).toBe('used')
          expect(calls).toBeGreaterThan(0)
        }
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

  it('sends every fixture that needs the model to the model, and reports the skip rate', () => {
    const decisions = fixtures.map((f) => ({
      f,
      decision: alreadyClean(prepareTranscript(f.transcript), contextOf(f))
    }))
    for (const { f, decision } of decisions)
      expect(decision.clean, `${f.id}: ${decision.reason ?? 'clean'}`).toBe(f.expect.skipModel === true)
    const mustSkip = decisions.filter((d) => d.f.expect.skipModel === true)
    const nearMisses = decisions.filter((d) => d.f.expect.skipModel === false)
    expect(mustSkip.length).toBeGreaterThanOrEqual(10)
    expect(nearMisses.length).toBeGreaterThanOrEqual(6)
    const reasons = new Map<string, number>()
    for (const { decision } of decisions)
      if (!decision.clean) reasons.set(decision.reason!, (reasons.get(decision.reason!) ?? 0) + 1)
    console.log(
      `[eval] clean skip: ${mustSkip.length}/${fixtures.length} fixtures (${Math.round((100 * mustSkip.length) / fixtures.length)}%) finish without the model; ` +
        `${nearMisses.length} near-misses and ${fixtures.length - mustSkip.length - nearMisses.length} original fixtures still reach it. ` +
        `Reasons: ${[...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r} ${n}`)
          .join(', ')}`
    )
  })

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
