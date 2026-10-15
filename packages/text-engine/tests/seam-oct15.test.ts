import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { joinPieces, joinSeam, stripEcho } from '../src/seam'

/**
 * Regression from Bennett's 5-minute Android dictation of Oct 15 2026 (tests/fixtures/
 * seam-oct15-transcript.txt is the text he got). Its defects came from the seams, not the model:
 * a 10-word formatter echo that survived, and four sentence ends that lost their period.
 */
const got = readFileSync(resolve(__dirname, 'fixtures/seam-oct15-transcript.txt'), 'utf8')

/** Split the delivered text at `marker` into the two pieces that were joined there. */
function piecesAt(marker: string): [string, string] {
  const at = got.indexOf(marker)
  expect(at).toBeGreaterThan(0)
  return [got.slice(0, at).trimEnd(), got.slice(at).trimStart()]
}

const ECHO = 'that this can achieve under half a second, but as reported,'

describe('seams of the Oct 15 dictation', () => {
  it('the delivered text has the echo (fixture sanity)', () => {
    expect(got.split(ECHO).length - 1).toBe(2)
  })

  it('joinSeam drops a 10-word repeat across the seam', () => {
    const second = got.indexOf(ECHO, got.indexOf(ECHO) + 1)
    const prev = got.slice(0, second).trimEnd()
    const next = got.slice(second)
    const joined = joinSeam(prev, next)
    expect(joined.text.split(ECHO).length - 1).toBe(1)
    expect(joined.text).toContain("but as reported, it's completing in roughly 0.8 seconds")
    expect(joined.deduped).toBeGreaterThanOrEqual(10)
  })

  it('stripEcho removes an echo that stops one word short of the context', () => {
    const context = 'I really would prefer that this can achieve under half a second, but as reported, it'
    const out = "That this can achieve under half a second, but as reported, it's completing in roughly 0.8 seconds."
    expect(stripEcho(out, context)).toBe("it's completing in roughly 0.8 seconds.")
  })

  it('stripEcho tolerates one changed word in a long echo', () => {
    const context = 'we should really move the release tail to the fast routes by default'
    const out = 'We should really move the release tail onto the fast routes by default, and keep the smart ones.'
    expect(stripEcho(out, context)).toBe('and keep the smart ones.')
  })

  it('restores the periods at the four sentence-end seams', () => {
    for (const [prevEnd, nextStart] of [
      ['to actually transcribe', 'But it would no doubt'],
      ['smartest models at all times', 'And only fast ones'],
      ['the point stands', "Now I've been speaking"]
    ]) {
      const [prev] = piecesAt(`${prevEnd} ${nextStart}`)
      const p = `${prev} ${prevEnd}`
      const n = got.slice(got.indexOf(`${prevEnd} ${nextStart}`) + prevEnd.length + 1)
      expect(joinSeam(p, n).text).toContain(`${prevEnd}. ${nextStart}`)
    }
  })

  it('does not add a period before "I" (it may continue the sentence)', () => {
    expect(joinSeam('I have paused a few times', "I'm hesitating.").text).toBe(
      "I have paused a few times I'm hesitating."
    )
  })

  it('keeps names and real continuations', () => {
    expect(joinSeam('We met with Sarah and', 'Sarah agreed.').text).toBe('We met with Sarah and Sarah agreed.')
  })

  it('does not dedupe a repeat that is not at the seam boundary', () => {
    const a = 'First we test the build. Then we ship the build to users'
    const b = 'Who asked for it.'
    expect(joinPieces([a, b]).text).toBe('First we test the build. Then we ship the build to users. Who asked for it.')
  })
})

describe('Kotlin parity cases', () => {
  it('match SeamTest.kt', () => {
    const echo = 'that this can achieve under half a second, but as reported,'
    expect(joinSeam(`I really would prefer ${echo}`, `${echo} it's completing in roughly 0.8 seconds apparently.`).text).toBe(
      `I really would prefer ${echo} it's completing in roughly 0.8 seconds apparently.`
    )
    expect(joinSeam('to actually transcribe', 'But it would no doubt be amazing.').text).toBe(
      'to actually transcribe. But it would no doubt be amazing.'
    )
  })
})
