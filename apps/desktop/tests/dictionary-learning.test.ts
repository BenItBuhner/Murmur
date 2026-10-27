import { describe, expect, it } from 'vitest'
import { findCorrections } from '@engine'
import type { DictionaryEntry } from '@shared/settings'
import { withCorrection } from '../src/renderer/src/lib/dictionary'

const entry = (word: string, aliases: string[] = []): DictionaryEntry => ({
  id: word,
  word,
  aliases,
  fuzzy: false,
  createdAt: 0
})

describe('learning dictionary words from a corrected dictation', () => {
  it('adds a corrected word with how it was heard', () => {
    const [c] = findCorrections('I use whisper flow daily.', 'I use Wispr Flow daily.')
    const next = withCorrection([], c, 5)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ word: 'Wispr Flow', aliases: ['whisper flow'], createdAt: 5 })
  })

  it('adds a new mis-hearing to the existing word, and nothing twice', () => {
    const dict = [entry('Murmur', ['murmer'])]
    const [c] = findCorrections('open mermer', 'open Murmur', dict)
    const next = withCorrection(dict, c)
    expect(next[0].aliases).toEqual(['murmer', 'mermer'])
    expect(withCorrection(next, c)).toEqual(next)
  })

  it('takes the user casing for a word already in the list', () => {
    const next = withCorrection([entry('convex')], {
      heard: 'convex',
      word: 'Convex',
      kind: 'alias'
    })
    expect(next[0].word).toBe('Convex')
  })
})
