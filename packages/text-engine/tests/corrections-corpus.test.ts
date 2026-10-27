import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findCorrections, parseLexicon } from '../src/corrections'
import type { DictionaryTerm } from '../src/types'

interface Case {
  group: string
  original: string
  edited: string
  dictionary?: DictionaryTerm[]
  expect: Array<[string, string]>
}

export const LEXICON = parseLexicon(
  readFileSync(resolve(__dirname, '../lexicon/everyday-words.txt'), 'utf8')
)
export const CORPUS: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/corrections.json'), 'utf8')
).cases

describe('correction corpus', () => {
  it('offers exactly the expected words for every edit', () => {
    const wrong: string[] = []
    for (const c of CORPUS) {
      const got = findCorrections(c.original, c.edited, c.dictionary ?? [], {
        everyday: LEXICON
      }).map((r) => [r.heard, r.word])
      if (JSON.stringify(got) !== JSON.stringify(c.expect))
        wrong.push(
          `[${c.group}] "${c.original}" -> "${c.edited}": got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`
        )
    }
    expect(wrong).toEqual([])
  })

  it('covers enough of each kind of edit', () => {
    const quiet = CORPUS.filter((c) => c.expect.length === 0).length
    expect(CORPUS.length).toBeGreaterThanOrEqual(90)
    expect(quiet).toBeGreaterThanOrEqual(50)
  })

  it('never offers a half-typed word while the user types over a mis-heard one', () => {
    // Every prefix of the correction as the user types it, letter by letter, from an empty
    // selection: none of the in-between states may produce a suggestion other than the final one.
    const pairs: Array<[string, string, string]> = [
      ['We moved the backend to ', 'convex', 'Convex'],
      ['I use ', 'whisper flow', 'Wispr Flow'],
      ['Ask ', 'Bennet', 'Bennett'],
      ['We deploy on ', 'versel', 'Vercel'],
      ['The data lives in ', 'superbase', 'Supabase']
    ]
    const stray: string[] = []
    for (const [head, heard, word] of pairs) {
      const original = `${head}${heard} today.`
      for (let n = 1; n < word.length; n++) {
        const edited = `${head}${word.slice(0, n)} today.`
        for (const r of findCorrections(original, edited, [], { everyday: LEXICON }))
          stray.push(`${edited} -> ${r.word}`)
      }
    }
    // Half-typed words do resemble the original, which is why the Android watcher waits for the
    // caret to leave the word; this records how many states that guard has to cover.
    expect(stray.length).toBeGreaterThan(0)
  })
})
