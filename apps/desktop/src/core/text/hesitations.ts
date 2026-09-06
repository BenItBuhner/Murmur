import type { HesitationLevel } from '@shared/settings'
import { isOpenerClause, lastClause } from './fillers'
import { escapeRegex } from './util'

/**
 * Hesitation phrases: multi-word verbal tics that a speech recognizer transcribes faithfully but
 * nobody wants typed ("you know", "I mean", a pause-"like", "let me think"). Unlike filler sounds
 * these words all have legitimate uses, so a phrase is only removed where the transcript marks it
 * as a pause: at the start of a sentence, wrapped in commas, or followed by punctuation, and never
 * after a word that makes it part of the sentence ("do you know", "I like", "it was like...").
 */

export interface HesitationEntry {
  phrase: string
  /** Lower-cased words after which the phrase is meaningful and must stay. */
  notAfter?: readonly string[]
  /** Only remove when a comma marks it as an aside (it is a hedge, not a pause). */
  requireComma?: boolean
  /** Keep it when it opens a sentence ("Yeah, that works" is an answer). */
  notAtStart?: boolean
  /** At the start of a sentence, only a comma marks it as a tic ("You know, …" vs "You know what I did"). */
  commaAtStart?: boolean
}

const VERB_SUBJECTS = [
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'people',
  'who',
  'that',
  'which',
  'to',
  'not',
  'do',
  'does',
  'did',
  "don't",
  "doesn't",
  "didn't",
  'would',
  "wouldn't",
  'really',
  'also',
  'still',
  'just',
  'much',
  'more',
  'something',
  'anything',
  'nothing',
  'things',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'being',
  'am',
  "i'm",
  "it's",
  "that's",
  "what's",
  "he's",
  "she's",
  "they're",
  "we're",
  "you're",
  'feel',
  'feels',
  'felt',
  'look',
  'looks',
  'looked',
  'sound',
  'sounds',
  'sounded',
  'seem',
  'seems',
  'seemed',
  'taste',
  'tastes',
  'smell',
  'smells'
]

const KNOW_CONTEXT = [
  'do',
  'did',
  'does',
  "don't",
  "didn't",
  "doesn't",
  'if',
  'whether',
  'than',
  'as',
  'let',
  'that',
  'what',
  'how',
  'why',
  'when',
  'where',
  'to',
  'would',
  'will',
  'should',
  'could',
  'can'
]

/** Pure hesitation: no meaning of its own in any position where it is removed. */
export const LIGHT_HESITATIONS: readonly HesitationEntry[] = [
  { phrase: 'you know what i mean' },
  { phrase: 'if you know what i mean' },
  { phrase: 'you know', notAfter: KNOW_CONTEXT, commaAtStart: true },
  { phrase: 'i mean', notAfter: ['what', 'do', 'did', 'you', 'they', 'we'], commaAtStart: true },
  { phrase: 'like', notAfter: VERB_SUBJECTS, requireComma: true },
  { phrase: 'let me think' },
  { phrase: 'let me see' },
  { phrase: "let's see" },
  { phrase: 'hold on' },
  { phrase: 'hang on' },
  { phrase: "what's the word" },
  { phrase: 'what was it' },
  { phrase: 'what is it called' },
  { phrase: "what's it called" },
  { phrase: 'how do i put this' },
  { phrase: 'how do i say this' },
  { phrase: 'how do you say' },
  { phrase: 'how should i put it' },
  { phrase: 'where was i' },
  { phrase: 'if that makes sense' },
  { phrase: 'does that make sense' },
  { phrase: 'so yeah' },
  { phrase: 'yeah so' },
  { phrase: 'okay so' },
  { phrase: 'ok so' },
  { phrase: 'alright so' },
  { phrase: 'and stuff like that' },
  { phrase: 'and things like that' },
  { phrase: 'or something like that' },
  { phrase: 'and so on and so forth' }
]

/** Hedges and discourse markers: meaningful sometimes, so only removed when marked as an aside. */
export const THOROUGH_HESITATIONS: readonly HesitationEntry[] = [
  { phrase: 'sort of', requireComma: true, notAfter: ['a', 'the', 'this', 'that', 'some', 'what'] },
  { phrase: 'kind of', requireComma: true, notAfter: ['a', 'the', 'this', 'that', 'some', 'what'] },
  { phrase: 'kinda', requireComma: true },
  { phrase: 'sorta', requireComma: true },
  { phrase: 'basically', requireComma: true },
  { phrase: 'actually', requireComma: true },
  { phrase: 'literally', requireComma: true },
  { phrase: 'honestly', requireComma: true },
  { phrase: 'to be honest', requireComma: true },
  { phrase: 'i guess', requireComma: true },
  { phrase: 'i suppose', requireComma: true },
  { phrase: 'or whatever' },
  { phrase: 'or something' },
  { phrase: 'and stuff' },
  { phrase: 'and whatnot' },
  { phrase: 'and everything', requireComma: true },
  { phrase: 'at the end of the day', requireComma: true },
  { phrase: 'yeah', requireComma: true, notAtStart: true },
  {
    phrase: 'right',
    requireComma: true,
    notAtStart: true,
    notAfter: [
      'the',
      'a',
      'all',
      'is',
      'was',
      "that's",
      "you're",
      "it's",
      'not',
      'turn',
      'to',
      'on',
      'my',
      'your',
      'be'
    ]
  },
  { phrase: 'anyway' },
  { phrase: 'anyways' }
]

/**
 * Sentence openers with no content, removed at `thorough` when the transcript pauses after the
 * last one ("Okay, so, we..." -> "We..."). The trailing comma is required so "So far so good"
 * keeps its "So".
 */
const OPENER_CHAIN =
  /(^|[.!?]\s+|\n\s*)(?:(?:okay|ok|alright|all right|yeah|yep|right|well|um|uh|and|so)[,.]?\s+)*(?:so|anyway|anyways|well|alright|all right)[,.]\s*(?:(?:um|uh)[,.]?\s+)*(?=\S)/giu

/** A conjunction the speaker never finished at the very end of the dictation. */
const LIGHT_TAIL = /(?<=\S)\s+(?:and|but|or|because|and then|so that|which)[,.\s…-]*$/iu
const THOROUGH_TAIL =
  /(?<=\S)\s+(?:and|but|or|because|and then|so that|which|so|yeah|so yeah|okay|ok)[,.\s…-]*$/iu

const CAP = '\u0000'

function compile(entries: readonly HesitationEntry[]): RegExp {
  const alternation = entries
    .map((e) => e.phrase.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((p) => escapeRegex(p).replace(/\s+/g, '\\s+').replace(/'/g, "['’]"))
    .join('|')
  // Group 1 lead: start, sentence end, ", " or whitespace. Group 3 trail: punctuation, dash pauses included.
  return new RegExp(
    `(^|[.!?]\\s+|\\n\\s*|,\\s*|\\s+)(${alternation})(?![\\p{L}\\p{N}'’-])(\\s*[,.!?;:—–-]*)(\\s*)`,
    'giu'
  )
}

const cache = new WeakMap<readonly HesitationEntry[], RegExp>()
function regexFor(entries: readonly HesitationEntry[]): RegExp {
  let re = cache.get(entries)
  if (!re) {
    re = compile(entries)
    cache.set(entries, re)
  }
  return re
}

export interface HesitationOptions {
  level: HesitationLevel
  /** User additions; treated like the light lexicon (removed wherever a pause marks them). */
  custom?: readonly string[]
}

const entriesCache = new Map<string, readonly HesitationEntry[]>()

export function entriesFor(opts: HesitationOptions): readonly HesitationEntry[] {
  if (opts.level === 'off') return []
  const custom = [
    ...new Set((opts.custom ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean))
  ]
  const cacheKey = `${opts.level}\u0000${custom.join('\u0000')}`
  const cached = entriesCache.get(cacheKey)
  if (cached) return cached
  const base =
    opts.level === 'thorough'
      ? [...LIGHT_HESITATIONS, ...THOROUGH_HESITATIONS]
      : [...LIGHT_HESITATIONS]
  const seen = new Set(base.map((e) => e.phrase))
  const entries = [...base, ...custom.filter((p) => !seen.has(p)).map((phrase) => ({ phrase }))]
  if (entriesCache.size > 32) entriesCache.clear()
  entriesCache.set(cacheKey, entries)
  return entries
}

/** Every single word that may vanish as hesitation; the LLM review accepts such deletions. */
export function hesitationWords(opts: HesitationOptions): Set<string> {
  const out = new Set<string>()
  for (const e of entriesFor(opts)) for (const w of e.phrase.split(/\s+/)) out.add(w)
  return out
}

export function removeHesitations(text: string, opts: HesitationOptions): string {
  if (opts.level === 'off' || !text) return text
  const entries = entriesFor(opts)
  const byPhrase = new Map(entries.map((e) => [e.phrase.replace(/\s+/g, ' '), e]))
  const re = regexFor(entries)
  const thorough = opts.level === 'thorough'

  let out = text
  // Two passes so a phrase revealed by removing another one ("so, like, you know, I think") goes too.
  for (let pass = 0; pass < 2; pass++) {
    const before = out
    out = out.replace(
      re,
      (
        match,
        lead: string,
        phrase: string,
        trail: string,
        space: string,
        offset: number,
        whole: string
      ) => {
        const key = phrase.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ')
        const entry = byPhrase.get(key)
        if (!entry) return match
        const prefix = whole.slice(0, offset)
        const atStart = lead === '' || /^[.!?]\s+$/.test(lead) || /^\n\s*$/.test(lead)
        const commaBefore = /^,\s*$/.test(lead)
        const trailPunct = trail.trim()
        const commaAfter = /^[,—–-]/.test(trailPunct)
        const sentenceEnd = /[.!?;:]/.test(trailPunct)
        const endPunct = trailPunct.replace(/^[,—–-]+/, '')

        // Mid-sentence and unmarked by any pause: these are real words.
        if (!atStart && !commaBefore && !trailPunct) return match
        if (entry.notAtStart && atStart) return match
        if (entry.requireComma) {
          if (!commaBefore && !commaAfter && !atStart) return match
          if (atStart && !commaAfter && !sentenceEnd) return match
          // ", right?" / ", okay?" are tag questions, not pauses.
          if (endPunct.startsWith('?')) return match
        }
        // A comma right before the phrase already marks it as an aside; otherwise the previous
        // word decides ("do you know", "I like", "it was like...").
        if (entry.notAfter && !atStart && !commaBefore) {
          const prev = lastWord(prefix + lead)
          if (prev && entry.notAfter.includes(prev)) return match
        }
        if ((entry.commaAtStart || key === 'like') && atStart && !commaAfter && !sentenceEnd)
          return match

        if (atStart) {
          if (sentenceEnd) return lead
          return `${lead}${CAP}`
        }
        // "It was great, you know?" is a statement once the tic is gone.
        const closing = endPunct.startsWith('?') ? `.${endPunct.slice(1)}` : endPunct
        if (sentenceEnd) return `${closing}${space || ' '}`
        if (commaBefore) {
          // "So, you know, we left" keeps the opener's comma; "think, you know, that" does not.
          return isOpenerClause(lastClause(prefix)) ? ', ' : ' '
        }
        return ' '
      }
    )
    if (out === before) break
  }

  if (thorough) out = out.replace(OPENER_CHAIN, (_m, lead: string) => `${lead}${CAP}`)
  out = out.replace(new RegExp(`${CAP}\\s*([\\s\\S]?)`, 'gu'), (_m, ch: string) => ch.toUpperCase())
  out = out.replace(thorough ? THOROUGH_TAIL : LIGHT_TAIL, '')
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
}

function lastWord(s: string): string {
  const m = s.match(/([\p{L}\p{N}'’]+)[^\p{L}\p{N}]*$/u)
  return m ? m[1].toLowerCase().replace(/’/g, "'") : ''
}
