import { describe, expect, it } from 'vitest'
import { editedSpan, findCorrections } from '../src/corrections'

describe('findCorrections', () => {
  it('suggests a new word when a mis-heard one is typed over', () => {
    expect(findCorrections('I use whisper flow every day.', 'I use Wispr Flow every day.')).toEqual(
      [{ heard: 'whisper flow', word: 'Wispr Flow', kind: 'add' }]
    )
    expect(findCorrections('Ask Bennet about it.', 'Ask Bennett about it.')).toEqual([
      { heard: 'Bennet', word: 'Bennett', kind: 'add' }
    ])
  })

  it('learns a name from a casing fix but not from a new capital at a sentence start', () => {
    expect(findCorrections('we deploy on convex.', 'we deploy on Convex.')).toEqual([
      { heard: 'convex', word: 'Convex', kind: 'add' }
    ])
    expect(findCorrections('the build is green.', 'The build is green.')).toEqual([])
  })

  it('records a new mis-hearing of a word already in the dictionary as an alias', () => {
    const dictionary = [{ word: 'Murmur', aliases: ['murmer'] }]
    expect(findCorrections('open mermer now', 'open Murmur now', dictionary)).toEqual([
      { heard: 'mermer', word: 'Murmur', kind: 'alias' }
    ])
    // A mis-hearing it already knows is no news.
    expect(findCorrections('open murmer now', 'open Murmur now', dictionary)).toEqual([])
  })

  it('stays quiet when the user changed their mind rather than the spelling', () => {
    expect(findCorrections('Send it on Tuesday.', 'Send it on Wednesday.')).toEqual([])
    expect(findCorrections('Please send the report.', 'Please forward the report.')).toEqual([])
    expect(findCorrections('I think their right.', "I think they're right.")).toEqual([])
    expect(findCorrections('It costs 5 dollars.', 'It costs 6 dollars.')).toEqual([])
  })

  it('ignores a rewrite of most of the text', () => {
    expect(
      findCorrections('Can we meet at the cafe tomorrow?', 'Could we maybe meat at a café today?')
    ).toEqual([])
  })

  it('ignores pure additions and deletions', () => {
    expect(findCorrections('Ship it.', 'Ship it today, Kubernetes.')).toEqual([])
    expect(findCorrections('Ship it right now.', 'Ship it.')).toEqual([])
  })

  it('skips paths, links, addresses, code symbols and ids', () => {
    expect(findCorrections('open the read me file', 'open the README.md file')).toEqual([
      { heard: 'read me', word: 'README.md', kind: 'add' }
    ])
    expect(findCorrections('set user id', 'set user_id')).toEqual([])
    expect(findCorrections('mail bob at example', 'mail bob@example')).toEqual([])
    expect(findCorrections('see commit abc', 'see commit abc1234f')).toEqual([])
  })
})

describe('editedSpan', () => {
  const before = 'Hi team, I use whisper flow daily. Cheers'
  const start = before.indexOf('I use')
  const end = before.indexOf(' Cheers')

  it('returns the dictation before and after an edit inside it', () => {
    const after = before.replace('whisper flow', 'Wispr Flow')
    expect(editedSpan(before, after, start, end)).toEqual({
      original: 'I use whisper flow daily.',
      edited: 'I use Wispr Flow daily.'
    })
  })

  it('widens a mid-word edit to the whole word', () => {
    const after = before.replace('whisper', 'wispr')
    expect(editedSpan(before, after, start, end)?.edited).toBe('I use wispr flow daily.')
  })

  it('ignores edits outside the dictation and unchanged fields', () => {
    expect(editedSpan(before, before, start, end)).toBeNull()
    expect(editedSpan(before, before.replace('Hi team', 'Hello all'), start, end)).toBeNull()
    expect(editedSpan(before, `${before} and more`, start, end)).toBeNull()
  })
})
