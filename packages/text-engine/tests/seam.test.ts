import { describe, expect, it } from 'vitest'
import { joinPieces, joinSeam, seamContext, stripEcho } from '../src/seam'

const j = (a: string, b: string): string => joinSeam(a, b).text

describe('joinSeam', () => {
  it('drops a word heard by both pieces and the period the cut added', () => {
    expect(j('Everything that would otherwise.', 'Otherwise, be picked up.')).toBe(
      'Everything that would otherwise be picked up.'
    )
  })
  it('merges an article heard twice', () => {
    expect(j('It adds a', 'An extra step.')).toBe('It adds an extra step.')
  })
  it('joins after a word that cannot end a sentence', () => {
    expect(j('I want to make this as.', "I'm going to keep it short.")).toBe(
      "I want to make this as I'm going to keep it short."
    )
    expect(j('It is literally.', 'Almost done.')).toBe('It is literally almost done.')
    expect(j("It's a question of...", 'If we can.')).toBe("It's a question of if we can.")
    expect(j('We need to.', 'To really fix it.')).toBe('We need to really fix it.')
  })
  it('joins at an ellipsis', () => {
    expect(j('Every single...', 'Clip is cut.')).toBe('Every single clip is cut.')
  })
  it('keeps a real sentence boundary', () => {
    expect(j('We tried their tools.', 'They suck.')).toBe('We tried their tools. They suck.')
    expect(j('Is it done?', 'Yes it is.')).toBe('Is it done? Yes it is.')
  })
  it('keeps names capitalized', () => {
    expect(j('I sent it to.', 'Sarah, and she said Sarah was busy.')).toBe(
      'I sent it to Sarah, and she said Sarah was busy.'
    )
    expect(j('We moved to the', 'API gateway.')).toBe('We moved to the API gateway.')
  })
  it('lowercases a capital after a bare continuation word', () => {
    expect(j('the build is', 'Green now.')).toBe('the build is green now.')
  })
  it('follows a lower-case start from the formatter', () => {
    expect(j('We shipped it.', 'and then it broke.')).toBe('We shipped it and then it broke.')
  })
  it('treats a doubled function word at the cut as an echo, not other short words', () => {
    expect(j('I gave it to the', 'the end.')).toBe('I gave it to the end.')
    expect(j('No', 'no, wait.')).toBe('No no, wait.')
  })
  it('joins a list', () => {
    expect(joinPieces(['A first part of.', 'The plan.', '', 'Done.']).text).toBe(
      'A first part of the plan. Done.'
    )
  })
})

describe('seamContext', () => {
  it('keeps the unfinished sentence at the end of a piece', () => {
    expect(seamContext('It is next week. Honestly I would rather keep the meeting short and')).toBe(
      'Honestly I would rather keep the meeting short and'
    )
  })
  it('takes the last sentence when the piece ended on one, capped in words', () => {
    expect(seamContext('First one. The second one is done.')).toBe('The second one is done.')
    expect(seamContext('one two three four five six seven eight', 4)).toBe('five six seven eight')
  })
})

describe('stripEcho', () => {
  it('drops a copy of the context at the start of the answer', () => {
    expect(
      stripEcho(
        'Honestly I would rather keep the meeting short and send the details by email.',
        'Honestly I would rather keep the meeting short and'
      )
    ).toBe('send the details by email.')
    expect(
      stripEcho('keep the meeting short and send it.', 'I would rather keep the meeting short and')
    ).toBe('send it.')
  })
  it('leaves an answer that does not repeat it', () => {
    expect(stripEcho('Send the details by email.', 'keep the meeting short and')).toBe(
      'Send the details by email.'
    )
    expect(stripEcho('and send it.', 'short and')).toBe('and send it.')
  })
})
