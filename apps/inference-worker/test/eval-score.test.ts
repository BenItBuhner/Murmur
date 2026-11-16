import { describe, expect, it } from 'vitest'
import { align, normalize } from '../eval/score'

describe('transcription eval scoring', () => {
  it('normalizes punctuation, case, digits and spelling', () => {
    expect(normalize('Mr. Smith, 4 men — endeavor!')).toEqual(['mister', 'smith', 'four', 'men', 'endeavour'])
  })
  it('counts inserted words separately and names them', () => {
    const a = align('he hoped there would be stew', 'He hoped there would be stew. Thank you.')
    expect(a).toMatchObject({ refWords: 6, insertions: 2, deletions: 0, substitutions: 0, errors: 2, inserted: ['thank', 'you'] })
  })
  it('scores substitutions and deletions', () => {
    const a = align('the cat sat on the mat', 'the bat sat the mat')
    expect(a).toMatchObject({ substitutions: 1, deletions: 1, insertions: 0 })
  })
  it('a cut clip may run past or stop short of its approximate reference', () => {
    expect(align('he hoped there', 'He hoped there would', true).errors).toBe(0)
    expect(align('he hoped there would', 'He hoped there', true).errors).toBe(0)
  })
  it('any word on a clip without speech is an insertion', () => {
    expect(align('', 'Thank you.')).toMatchObject({ refWords: 0, insertions: 2 })
  })
})
