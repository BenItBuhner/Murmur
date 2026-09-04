import type { DictionaryEntry } from '@shared/settings'
import { WB_END, WB_START, editDistance, escapeRegex, isCapitalized } from './util'

interface Compiled {
  exact: RegExp | null
  canonical: Map<string, string>
  fuzzyTerms: Array<{ term: string; canonical: string; fuzzy: boolean }>
  allLower: Set<string>
}

const cache = new WeakMap<readonly DictionaryEntry[], Compiled>()

function compile(entries: readonly DictionaryEntry[]): Compiled {
  const cached = cache.get(entries)
  if (cached) return cached
  const canonical = new Map<string, string>()
  const fuzzyTerms: Compiled['fuzzyTerms'] = []
  const allLower = new Set<string>()
  for (const e of entries) {
    const word = e.word.trim()
    if (!word) continue
    allLower.add(word.toLowerCase())
    for (const variant of [word, ...e.aliases]) {
      const v = variant.trim()
      if (!v) continue
      const key = v.toLowerCase()
      if (!canonical.has(key)) canonical.set(key, word)
      if (!/\s/.test(v)) fuzzyTerms.push({ term: key, canonical: word, fuzzy: e.fuzzy })
    }
  }
  const keys = [...canonical.keys()].sort((a, b) => b.length - a.length)
  const exact = keys.length
    ? new RegExp(
        `${WB_START}(?:${keys.map((k) => escapeRegex(k).replace(/\s+/g, '\\s+')).join('|')})${WB_END}`,
        'giu'
      )
    : null
  const compiled = { exact, canonical, fuzzyTerms, allLower }
  cache.set(entries, compiled)
  return compiled
}

/**
 * Enforce dictionary spellings. Exact (case-insensitive) matches of a word or any of its
 * aliases become the canonical spelling. Then a fuzzy pass corrects near-misses for terms
 * that opted in (`fuzzy`) or when the transcript token is capitalized (a probable name).
 */
export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  if (!entries.length || !text) return text
  const c = compile(entries)
  let out = text
  if (c.exact) {
    out = out.replace(c.exact, (m) => c.canonical.get(m.toLowerCase().replace(/\s+/g, ' ')) ?? m)
  }
  if (c.fuzzyTerms.length) {
    out = out.replace(/[\p{L}][\p{L}\p{N}'’-]{3,}/gu, (token) => {
      const lower = token.toLowerCase()
      if (c.allLower.has(lower) || c.canonical.has(lower)) return token
      const capitalized = isCapitalized(token)
      let best: { canonical: string; d: number } | null = null
      for (const t of c.fuzzyTerms) {
        if (!t.fuzzy && !capitalized) continue
        if (Math.abs(t.term.length - lower.length) > 2) continue
        const maxD = t.term.length >= 8 ? 2 : 1
        const d = editDistance(lower, t.term, maxD)
        if (d <= maxD && (!best || d < best.d)) best = { canonical: t.canonical, d }
      }
      return best ? best.canonical : token
    })
  }
  return out
}

/**
 * Whisper-style initial prompt that biases decoding toward the user's vocabulary.
 * Kept short: Whisper only honours the last ~224 tokens of the prompt.
 */
export function buildSttPrompt(
  entries: readonly DictionaryEntry[],
  snippetTriggers: readonly string[] = [],
  maxChars = 600
): string {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const w = e.word.trim()
    if (w && !seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase())
      terms.push(w)
    }
  }
  for (const t of snippetTriggers) {
    const w = t.trim()
    if (w && !seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase())
      terms.push(w)
    }
  }
  const base = 'Dictation with punctuation.'
  if (!terms.length) return base
  let glossary = ''
  for (const t of terms) {
    const next = glossary ? `${glossary}, ${t}` : t
    if (base.length + next.length + 12 > maxChars) break
    glossary = next
  }
  return `${base} Vocabulary: ${glossary}.`
}
