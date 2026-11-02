import { describe, expect, it } from 'vitest'
import { joinPieces, rawSeamContinues } from '../src/seam'
import { capitalizeSentences } from '../src/text'

describe('a seam the recognizer heard as one sentence', () => {
  it('is read from the raw pieces', () => {
    // Whisper started the next piece in lower case: it heard the sentence go on.
    expect(rawSeamContinues('We need a written plan before it', 'starts and Dana owns it.')).toBe(
      true
    )
    // A cut the raw join repairs ("to." then a capital).
    expect(rawSeamContinues('I also want to.', 'Stop measuring the day.')).toBe(true)
    expect(rawSeamContinues('That is the plan.', 'Next we ship it.')).toBe(false)
    expect(rawSeamContinues('Are we done?', 'and then what')).toBe(false)
  })

  it('keeps formatting each piece alone from closing that sentence', () => {
    const formatted = ['We need a written plan before it.', 'Starts and Dana owns it.']
    expect(joinPieces(formatted).text).toBe(
      'We need a written plan before it. Starts and Dana owns it.'
    )
    expect(joinPieces(formatted, [true]).text).toBe(
      'We need a written plan before it starts and Dana owns it.'
    )
    // A name (capitalized mid-sentence elsewhere) keeps its capital.
    expect(joinPieces(['I told Dana and sent it to.', 'Dana yesterday.'], [true]).text).toBe(
      'I told Dana and sent it to Dana yesterday.'
    )
    // Empty pieces do not shift which seam is which.
    expect(joinPieces(['One plan before it.', '', 'Starts now.'], [true, false]).text).toBe(
      'One plan before it starts now.'
    )
  })
})

describe('trailing-off dots', () => {
  it('do not start a sentence before a lower-case word', () => {
    expect(capitalizeSentences('it was sent to a... channel before I noticed')).toBe(
      'It was sent to a... channel before I noticed'
    )
    expect(capitalizeSentences('it was done. next one')).toBe('It was done. Next one')
  })
})
