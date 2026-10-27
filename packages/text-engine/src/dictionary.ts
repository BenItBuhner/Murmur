import type { DictionaryTerm } from './types'
import { WB_END, WB_START, escapeRegex } from './text'

/**
 * A rough sound key for a Latin-script word, in the spirit of Metaphone: what it sounds like
 * rather than how it is spelt, so "whisper" and "Wispr", "Bennet" and "Bennett", "Konvex" and
 * "Convex" collide. Vowels after the first are dropped, doubled letters collapsed, common
 * digraphs and silent letters folded. Non-Latin words come back unchanged apart from casing.
 */
export function soundKey(word: string): string {
  const lower = word
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  if (!/^[a-z'’-]+$/.test(lower)) return lower.replace(/[^\p{L}\p{N}]/gu, '')
  let w = lower.replace(/[^a-z]/g, '')
  if (!w) return ''
  w = w.replace(/^(?:kn|gn|pn|wr)/, (m) => m[1])
  w = w.replace(/^x/, 's').replace(/^wh/, 'w')
  w = w.replace(/ph/g, 'f')
  w = w.replace(/tch/g, 'ch').replace(/sch/g, 'sk').replace(/ch/g, 'x').replace(/sh/g, 'x')
  w = w.replace(/th/g, '0')
  w = w
    .replace(/gh(?![aeiou])/g, '')
    .replace(/dg/g, 'j')
    .replace(/ck/g, 'k')
  w = w.replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
  w = w.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
  w = w.replace(/mb$/, 'm')
  w = w.replace(/[wy](?![aeiou])/g, '')
  w = w.replace(/v/g, 'f').replace(/d/g, 't')
  w = w.replace(/(.)\1+/g, '$1')
  if (!w) return ''
  return w[0] + w.slice(1).replace(/[aeiouy]/g, '')
}

/** The first vowel sound of a word: the one piece of vowel information the sound key keeps. */
export function firstVowel(word: string): string {
  const m = word.toLowerCase().match(/[aeiouy]/)
  if (!m) return ''
  return m[0] === 'y' ? 'i' : m[0]
}

interface Compiled {
  exact: RegExp | null
  canonical: Map<string, string>
}

const cache = new WeakMap<readonly DictionaryTerm[], Compiled>()

function compile(entries: readonly DictionaryTerm[]): Compiled {
  const cached = cache.get(entries)
  if (cached) return cached
  const canonical = new Map<string, string>()
  for (const e of entries) {
    const word = e.word.trim()
    if (!word) continue
    for (const variant of [word, ...e.aliases]) {
      const key = variant.trim().toLowerCase().replace(/\s+/g, ' ')
      if (key && !canonical.has(key)) canonical.set(key, word)
    }
  }
  const keys = [...canonical.keys()].sort((a, b) => b.length - a.length)
  const exact = keys.length
    ? new RegExp(
        `${WB_START}(?:${keys.map((k) => escapeRegex(k).replace(/\s+/g, '\\s+')).join('|')})${WB_END}`,
        'giu'
      )
    : null
  const compiled = { exact, canonical }
  cache.set(entries, compiled)
  return compiled
}

/**
 * Enforce dictionary spellings, and nothing else. The dictionary is a plain list: the formatting
 * model reads it (see `dictionaryLine`) and decides from context where a word was meant, which is
 * the judgement a rule cannot make. What the rules still do is exact: a word typed in any casing
 * gets the dictionary's casing ("convex" -> "Convex"), and a mis-hearing the user recorded (an
 * alias, usually learned from one of their own corrections) becomes the word. There is no guessing
 * by sound or spelling here any more; that used to turn ordinary words into dictionary terms.
 */
export function applyDictionary(text: string, entries: readonly DictionaryTerm[]): string {
  if (!entries.length || !text) return text
  const c = compile(entries)
  if (!c.exact) return text
  return text.replace(c.exact, (m) => c.canonical.get(m.toLowerCase().replace(/\s+/g, ' ')) ?? m)
}

/** Style hint that goes to the speech model on its own; nothing in it can be mistaken for speech. */
export const STT_BASE_PROMPT = 'Dictation with punctuation.'

/**
 * Whisper-style prompt that biases decoding toward the user's vocabulary. Whisper reads the
 * prompt as the transcript of the previous segment, so it must never end with a term the speaker
 * may say: with a term at the very end the model learns that "end of text" follows it, and the
 * transcript stops the moment the term is spoken. The vocabulary therefore comes first and a
 * neutral sentence closes the prompt. Kept short: Whisper only honours the last ~224 tokens.
 */
export function buildSttPrompt(
  entries: readonly DictionaryTerm[],
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
  if (!terms.length) return STT_BASE_PROMPT
  let glossary = ''
  for (const t of terms) {
    const next = glossary ? `${glossary}, ${t}` : t
    if (STT_BASE_PROMPT.length + next.length + 14 > maxChars) break
    glossary = next
  }
  return glossary ? `Vocabulary: ${glossary}. ${STT_BASE_PROMPT}` : STT_BASE_PROMPT
}
