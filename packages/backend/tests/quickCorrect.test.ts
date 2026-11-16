import { describe, expect, it } from 'vitest'
import { CORRECT_SYSTEM_PROMPT, cleanCorrection, correctionMessages, parseOverride } from '../convex/lib/quickCorrect'

describe('Quick Correct prompt rules', () => {
  it('uses the minimal-fix prompt when there is no {...} block', () => {
    expect(parseOverride('i has a cat')).toEqual({ text: 'i has a cat', override: null })
    expect(correctionMessages(parseOverride('i has a cat'))[0]!.content).toBe(CORRECT_SYSTEM_PROMPT)
  })

  it('a {...} block anywhere replaces the prompt and leaves the text', () => {
    expect(parseOverride('{make it formal} hey whats up')).toEqual({ text: 'hey whats up', override: 'make it formal' })
    expect(parseOverride('hey {shorter} there')).toEqual({ text: 'hey there', override: 'shorter' })
    expect(parseOverride('line one\n{bullets}\nline two')).toEqual({ text: 'line one\n\nline two', override: 'bullets' })
    expect(correctionMessages(parseOverride('x {be brief}'))[0]!.content.startsWith('be brief')).toBe(true)
  })

  it('leaves code-like braces alone', () => {
    expect(parseOverride('const a = {}').override).toBeNull()
    expect(parseOverride('f({ 1, 2 })').override).toBeNull()
  })

  it('names dictionary words as correct', () => {
    expect(correctionMessages(parseOverride('x'), ['Ephemeris', ' ', 'Bennett'])[0]!.content).toContain('Ephemeris, Bennett')
  })

  it('cleans model wrappers and keeps the selection whitespace', () => {
    expect(cleanCorrection('Corrected text: I have a cat.', 'i has a cat')).toBe('I have a cat.')
    expect(cleanCorrection('"I have a cat."', '  i has a cat\n')).toBe('  I have a cat.\n')
    expect(cleanCorrection('"Quoted."', '"quoted"')).toBe('"Quoted."')
    expect(cleanCorrection('   ', 'x')).toBe('')
  })
})
