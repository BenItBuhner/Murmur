import type { WordCorrection } from '@engine'
import type { DictionaryEntry } from '@shared/settings'
import { uid } from './utils'

/**
 * The dictionary with one learned correction applied: a new word (remembering how it was heard),
 * one more "heard as" spelling on an existing word, or the user's casing for a word already there.
 * Mirrors WordSuggestions.withSuggestion on Android.
 */
export function withCorrection(
  entries: readonly DictionaryEntry[],
  c: WordCorrection,
  now = Date.now()
): DictionaryEntry[] {
  const existing = entries.find((e) => e.word.toLowerCase() === c.word.toLowerCase())
  const heard = c.heard.toLowerCase() === c.word.toLowerCase() ? null : c.heard
  if (!existing) {
    const entry: DictionaryEntry = {
      id: uid(),
      word: c.word,
      aliases: heard ? [heard] : [],
      fuzzy: false,
      createdAt: now
    }
    return [entry, ...entries]
  }
  if (!heard)
    return existing.word === c.word
      ? [...entries]
      : entries.map((e) => (e.id === existing.id ? { ...e, word: c.word } : e))
  if (existing.aliases.some((a) => a.toLowerCase() === heard.toLowerCase())) return [...entries]
  return entries.map((e) => (e.id === existing.id ? { ...e, aliases: [...e.aliases, heard] } : e))
}
