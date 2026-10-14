import { describe, expect, it } from 'vitest'
import { repairOutput, repeatedRuns, verifyOutput } from '../src/verify'

describe('repairOutput', () => {
  it('says a doubled run once when the speaker said it once', () => {
    expect(
      repairOutput(
        'for more information or to volunteer please visit librivox.org',
        'For more information, or to volunteer, please visit LIBRIVOX.org LIBRIVOX.org.'
      )
    ).toBe('For more information, or to volunteer, please visit LIBRIVOX.org.')
  })
  it('keeps repetition the speaker said, and repeated numbers', () => {
    expect(repairOutput('no no no not that one', 'No, no, no, not that one.')).toBe('No, no, no, not that one.')
    expect(repairOutput('five thousand five thousand', '5,000, 5,000')).toBe('5,000, 5,000')
  })
  it('joins line breaks nobody dictated', () => {
    expect(repairOutput('the cat sat on the mat and then it slept', 'The cat sat on the mat.\n\nAnd then it slept.')).toBe(
      'The cat sat on the mat. And then it slept.'
    )
  })
  it('keeps dictated breaks and lists', () => {
    expect(repairOutput('hello there new line how are you', 'Hello there.\nHow are you?')).toBe('Hello there.\nHow are you?')
    expect(repairOutput('first buy milk second buy eggs', '1. Buy milk\n2. Buy eggs')).toBe('1. Buy milk\n2. Buy eggs')
    expect(repairOutput('line one\nline two', 'Line one.\nLine two.')).toBe('Line one.\nLine two.')
  })
})

describe('repeated invariant', () => {
  it('rejects a sentence said twice', () => {
    const t = 'this is a librivox recording all librivox recordings are in the public domain'
    const o = 'This is a LibriVox recording. All LibriVox recordings are in the public domain. This is a LibriVox recording.'
    expect(repeatedRuns(t, o, 4).length).toBeGreaterThan(0)
    expect(verifyOutput(t, o)).toMatchObject({ ok: false, reason: 'repeated' })
  })
  it('accepts a speaker who repeated themselves', () => {
    const t = 'we need to ship it we need to ship it today'
    expect(verifyOutput(t, 'We need to ship it. We need to ship it today.').ok).toBe(true)
  })
})
