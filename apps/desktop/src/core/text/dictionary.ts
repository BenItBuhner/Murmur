import type { DictionaryEntry } from '@shared/settings'
import { WB_END, WB_START, editDistance, escapeRegex, isCapitalized } from './util'

interface FuzzyTerm {
  term: string
  canonical: string
  fuzzy: boolean
  key: string
  vowel: string
}

interface PhraseTerm {
  canonical: string
  /** Lower-cased words of the term or alias. */
  words: string[]
  key: string
  vowel: string
  fuzzy: boolean
}

interface Compiled {
  exact: RegExp | null
  canonical: Map<string, string>
  fuzzyTerms: FuzzyTerm[]
  phrases: PhraseTerm[]
  allLower: Set<string>
}

const cache = new WeakMap<readonly DictionaryEntry[], Compiled>()

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
  return w[0] + w.slice(1).replace(/[aeiouy]/g, '')
}

/** The first vowel sound of a word: the one piece of vowel information the sound key keeps. */
function firstVowel(word: string): string {
  const m = word.toLowerCase().match(/[aeiouy]/)
  if (!m) return ''
  return m[0] === 'y' ? 'i' : m[0]
}

function phraseKey(words: readonly string[]): string {
  return words.map(soundKey).join('')
}

function compile(entries: readonly DictionaryEntry[]): Compiled {
  const cached = cache.get(entries)
  if (cached) return cached
  const canonical = new Map<string, string>()
  const fuzzyTerms: FuzzyTerm[] = []
  const phrases: PhraseTerm[] = []
  const allLower = new Set<string>()
  for (const e of entries) {
    const word = e.word.trim()
    if (!word) continue
    allLower.add(word.toLowerCase())
    // The words of a canonical spelling are final; the fuzzy pass must not touch them.
    for (const part of word.toLowerCase().split(/[\s-]+/)) if (part) allLower.add(part)
    for (const variant of [word, ...e.aliases]) {
      const v = variant.trim()
      if (!v) continue
      const key = v.toLowerCase().replace(/\s+/g, ' ')
      if (!canonical.has(key)) canonical.set(key, word)
      const words = key.split(/[\s-]+/).filter(Boolean)
      if (words.length === 1) {
        fuzzyTerms.push({
          term: key,
          canonical: word,
          fuzzy: e.fuzzy,
          key: soundKey(key),
          vowel: firstVowel(key)
        })
      } else if (words.length <= 5) {
        const phrase = phraseKey(words)
        // Too little sound to go on ("Go To" is just "gt"); exact and alias matching still apply.
        if (phrase.length < 4) continue
        phrases.push({
          canonical: word,
          words,
          key: phrase,
          vowel: firstVowel(words.join('')),
          fuzzy: e.fuzzy
        })
      }
    }
  }
  const keys = [...canonical.keys()].sort((a, b) => b.length - a.length)
  const exact = keys.length
    ? new RegExp(
        `${WB_START}(?:${keys.map((k) => escapeRegex(k).replace(/\s+/g, '\\s+')).join('|')})${WB_END}`,
        'giu'
      )
    : null
  phrases.sort((a, b) => b.words.length - a.words.length || b.key.length - a.key.length)
  const compiled = { exact, canonical, fuzzyTerms, phrases, allLower }
  cache.set(entries, compiled)
  return compiled
}

/** Same sound and the same first vowel: a mis-spelling or mis-hearing of the term. */
function soundsLike(
  key: string,
  vowel: string,
  term: { key: string; vowel: string },
  allowNear: boolean
): boolean {
  if (!key || !term.key || vowel !== term.vowel) return false
  if (key === term.key) return true
  if (!allowNear || term.key.length < 5) return false
  return Math.abs(key.length - term.key.length) <= 1 && editDistance(key, term.key, 1) <= 1
}

interface Token {
  text: string
  start: number
  end: number
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(TOKEN_RE))
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/**
 * Multi-word terms: "Wispr Flow" comes back from the recognizer as "whisper flow", "Whisper Flo"
 * or "whisperflow". Windows of n-1..n+1 words are compared by sound; a matching window becomes
 * the canonical spelling. An exact sound match is trusted for every entry (two or more words
 * that happen to sound like the term are rarely a coincidence); a near match needs the entry to
 * opt in to fuzzy matching or the window to be capitalized like a name.
 */
function applyPhrases(text: string, c: Compiled): string {
  if (!c.phrases.length) return text
  const tokens = tokenize(text)
  if (tokens.length < 1) return text
  const matches: Array<{ start: number; end: number; replacement: string }> = []
  const taken: boolean[] = new Array(tokens.length).fill(false)
  // Words that already spell a term (or an alias) are final; no window may swallow them.
  if (c.exact) {
    for (const m of text.matchAll(c.exact)) {
      const from = m.index
      const to = from + m[0].length
      tokens.forEach((t, i) => {
        if (t.start >= from && t.end <= to) taken[i] = true
      })
    }
  }
  for (const phrase of c.phrases) {
    const n = phrase.words.length
    for (const size of [n, n - 1, n + 1]) {
      if (size < 1 || size > tokens.length) continue
      // A merged or split rendering ("whisperflow", "wisp or flow") needs a longer sound to match.
      if (size !== n && phrase.key.length < 5) continue
      for (let i = 0; i + size <= tokens.length; i++) {
        let free = true
        for (let k = i; k < i + size && free; k++) free = !taken[k]
        if (!free) continue
        // Only whitespace or hyphens may sit between the words of a phrase.
        let contiguous = true
        for (let k = i + 1; k < i + size && contiguous; k++)
          contiguous = /^[\s-]*$/.test(text.slice(tokens[k - 1].end, tokens[k].start))
        if (!contiguous) continue
        const window = tokens.slice(i, i + size)
        const joined = window
          .map((t) => t.text)
          .join(' ')
          .toLowerCase()
          .replace(/\s+/g, ' ')
        if (joined === phrase.canonical.toLowerCase() || c.canonical.has(joined)) continue
        const letters = window.map((t) => t.text).join('')
        const key = phraseKey(window.map((t) => t.text))
        const capitalized = window.some((t) => isCapitalized(t.text))
        // A near match is only trusted when the word count lines up; a merged or split
        // rendering has to sound exactly right.
        const allowNear = size === n && (phrase.fuzzy || capitalized)
        if (!soundsLike(key, firstVowel(letters), phrase, allowNear)) continue
        matches.push({
          start: window[0].start,
          end: window[window.length - 1].end,
          replacement: phrase.canonical
        })
        for (let k = i; k < i + size; k++) taken[k] = true
      }
    }
  }
  if (!matches.length) return text
  matches.sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const m of matches) {
    out += text.slice(pos, m.start) + m.replacement
    pos = m.end
  }
  return out + text.slice(pos)
}

/**
 * Enforce dictionary spellings. Exact (case-insensitive) matches of a word or any of its
 * aliases become the canonical spelling. Then multi-word terms are matched by sound, and a fuzzy
 * pass corrects single-word near-misses (by spelling or by sound) for terms that opted in
 * (`fuzzy`) or when the transcript token is capitalized (a probable name).
 */
export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  if (!entries.length || !text) return text
  const c = compile(entries)
  let out = text
  if (c.exact) {
    out = out.replace(c.exact, (m) => c.canonical.get(m.toLowerCase().replace(/\s+/g, ' ')) ?? m)
  }
  out = applyPhrases(out, c)
  if (c.fuzzyTerms.length) {
    out = out.replace(/[\p{L}][\p{L}\p{N}'’-]{3,}/gu, (token) => {
      const lower = token.toLowerCase()
      if (c.allLower.has(lower) || c.canonical.has(lower)) return token
      const capitalized = isCapitalized(token)
      const key = soundKey(lower)
      const vowel = firstVowel(lower)
      let best: { canonical: string; d: number } | null = null
      for (const t of c.fuzzyTerms) {
        if (!t.fuzzy && !capitalized) continue
        let d = Infinity
        if (Math.abs(t.term.length - lower.length) <= 2) {
          const maxD = t.term.length >= 8 ? 2 : 1
          const spelling = editDistance(lower, t.term, maxD)
          if (spelling <= maxD) d = spelling
        }
        if (d > 1 && t.term.length >= 4 && soundsLike(key, vowel, t, true))
          d = Math.min(d, key === t.key ? 0.5 : 1.5)
        if (d !== Infinity && (!best || d < best.d)) best = { canonical: t.canonical, d }
      }
      return best ? best.canonical : token
    })
  }
  return out
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
  if (!terms.length) return STT_BASE_PROMPT
  let glossary = ''
  for (const t of terms) {
    const next = glossary ? `${glossary}, ${t}` : t
    if (STT_BASE_PROMPT.length + next.length + 14 > maxChars) break
    glossary = next
  }
  return glossary ? `Vocabulary: ${glossary}. ${STT_BASE_PROMPT}` : STT_BASE_PROMPT
}
