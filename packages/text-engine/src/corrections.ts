import { soundKey } from './dictionary'
import { editDistance } from './text'
import type { DictionaryTerm } from './types'

/**
 * Learning from the user's own corrections, the way Wispr Flow does: Murmur typed "whisper flow",
 * the user selected it and typed "Wispr Flow", so Murmur offers to add "Wispr Flow" to the
 * dictionary, remembering "whisper flow" as how the speech model hears it.
 *
 * The platform part (seeing the edit) differs: Android re-reads the field it typed into, the
 * desktop app compares an edited History entry. This module is the shared judgement of whether a
 * change is a correction of a mis-heard word (worth a dictionary entry) or just the user
 * rewriting their text (not worth anything). It errs towards silence: a suggestion nobody wanted
 * is worse than a missed one.
 */

export interface WordCorrection {
  /** What Murmur typed. */
  heard: string
  /** What the user changed it to: the dictionary spelling. */
  word: string
  /**
   * `add`: the word is not in the dictionary yet. `alias`: it is, but this mis-hearing is new; it
   * is recorded on the entry so the next dictation gets it right without the model.
   */
  kind: 'add' | 'alias'
}

/** The most frequent English words: a change between two of them is wording, not a mis-hearing. */
const COMMON = new Set(
  `a about above after again against all also am an and any are as at be because been before
  being below between both but by can could did do does doing done down during each few for from
  further get got had has have having he her here hers herself him himself his how i if in into is
  it its itself just let like make me more most my myself no nor not now of off on once only or
  other our ours ourselves out over own same say said see she should so some such than that the
  their theirs them themselves then there these they this those through to too under until up us
  very was we were what when where which while who whom why will with would you your yours
  yourself yourselves one two three four five six seven eight nine ten first last next new old
  good great little big long high right left well way day time year people thing things man
  woman know think go going come came take took give gave tell told ask work call try need feel
  become leave put mean keep begin seem help show hear play run move live believe bring happen
  write sit stand lose pay meet include continue set learn change lead understand watch follow
  stop create speak read spend grow open walk win offer remember love consider appear buy wait
  serve die send expect build stay fall cut reach kill remain much many still even back there's
  it's i'm don't can't won't isn't aren't wasn't weren't didn't doesn't that's what's let's
  we're they're you're i've we've you've i'd we'd you'd i'll we'll you'll okay ok yes yeah hey
  hi thanks thank please sorry maybe really actually probably today tomorrow yesterday week
  month here's where's who's quite though although whether else ever never always sometimes
  often already yet soon later around away anything something nothing everything someone
  anyone everyone today's an the`
    .split(/\s+/)
    .filter(Boolean)
)

interface Token {
  text: string
  start: number
  end: number
}

/** A word, with the joins that live inside identifiers and names ("Node.js", "e-mail", "T3"). */
const TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}'’_.-]*[\p{L}\p{N}])?/gu

function tokenize(text: string): Token[] {
  const out: Token[] = []
  for (const m of text.matchAll(TOKEN_RE))
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return out
}

/** At most this many words on either side of one change: more is a rewrite. */
const MAX_HUNK_WORDS = 3
/** At most this many suggestions from one edit. */
const MAX_SUGGESTIONS = 3
/** Beyond this many words (after the common ends are trimmed) the edit is not looked at. */
const MAX_DIFF_WORDS = 300

interface Hunk {
  removed: Token[]
  added: Token[]
}

/**
 * Word-level diff: the common words at both ends are trimmed, the middle is aligned by longest
 * common subsequence, and every run of removed and added words between two kept ones is a hunk.
 */
function diffWords(a: Token[], b: Token[]): Hunk[] | null {
  let head = 0
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail].text === b[b.length - 1 - tail].text
  )
    tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (!x.length && !y.length) return []
  if (x.length > MAX_DIFF_WORDS || y.length > MAX_DIFF_WORDS) return null
  const n = x.length
  const m = y.length
  // lcs[i][j]: length of the longest common subsequence of x[i..] and y[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        x[i].text === y[j].text ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const hunks: Hunk[] = []
  let cur: Hunk = { removed: [], added: [] }
  const flush = (): void => {
    if (cur.removed.length || cur.added.length) hunks.push(cur)
    cur = { removed: [], added: [] }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i].text === y[j].text) {
      flush()
      i++
      j++
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.added.push(y[j++])
    else cur.removed.push(x[i++])
  }
  flush()
  return hunks
}

const letters = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

const isCommon = (word: string): boolean =>
  word.split(/\s+/).every((w) => COMMON.has(w.toLowerCase().replace(/’/g, "'")))

/**
 * What is never a dictionary word even when the user typed it over a dictation: paths, links,
 * addresses, code symbols, hashes and ids, numbers and dates (the same skip list Wispr Flow uses).
 */
function notAWord(word: string): boolean {
  if (/[/\\@:_#=<>{}[\]()*`|~^$%&+]/.test(word)) return true
  if (/^[0-9a-f]{7,}$/i.test(word) && /\d/.test(word)) return true
  const digits = (word.match(/\p{N}/gu) ?? []).length
  const alpha = (word.match(/\p{L}/gu) ?? []).length
  return digits > alpha
}

/**
 * Whether `word` is a plausible re-spelling of what was heard: it sounds the same, or it is only a
 * few letters away. "whisper flow" -> "Wispr Flow" and "Bennet" -> "Bennett" are; "Tuesday" ->
 * "Wednesday" and "send" -> "forward" are not (the user changed their mind, not the spelling).
 */
function resembles(heard: string, word: string): boolean {
  const a = letters(heard)
  const b = letters(word)
  if (!a || !b) return false
  if (a === b) return true
  const keyA = heard.split(/\s+/).map(soundKey).join('')
  const keyB = word
    .split(/[\s.-]+/)
    .map(soundKey)
    .join('')
  if (keyA.length >= 2 && keyA === keyB) return true
  const longest = Math.max(a.length, b.length)
  if (longest < 3) return false
  const allowed = longest <= 4 ? 1 : Math.max(1, Math.floor(longest * 0.4))
  return editDistance(a, b, allowed) <= allowed
}

/**
 * The dictionary-worthy corrections in one edit of text Murmur typed. `original` is what Murmur
 * inserted, `edited` the same span after the user worked on it.
 */
export function findCorrections(
  original: string,
  edited: string,
  dictionary: readonly DictionaryTerm[] = []
): WordCorrection[] {
  const before = tokenize(original)
  const after = tokenize(edited)
  if (!before.length || !after.length) return []
  const hunks = diffWords(before, after)
  if (!hunks || !hunks.length) return []
  // When most of the words changed, the user rewrote the text; nothing in it is a correction.
  const changed = hunks.reduce((n, h) => n + Math.max(h.removed.length, h.added.length), 0)
  if (before.length >= 4 && changed > before.length / 2) return []

  const byWord = new Map<string, DictionaryTerm>()
  const byVariant = new Map<string, DictionaryTerm>()
  for (const d of dictionary) {
    const w = d.word.trim().toLowerCase()
    if (!w) continue
    byWord.set(w, d)
    byVariant.set(w, d)
    for (const a of d.aliases) if (a.trim()) byVariant.set(a.trim().toLowerCase(), d)
  }

  const out: WordCorrection[] = []
  const seen = new Set<string>()
  for (const h of hunks) {
    if (!h.removed.length || !h.added.length) continue
    if (h.removed.length > MAX_HUNK_WORDS || h.added.length > MAX_HUNK_WORDS) continue
    const heard = h.removed.map((t) => t.text).join(' ')
    // The user's own spelling, with the spaces, dots and hyphens they typed between the words.
    const word = edited.slice(h.added[0].start, h.added[h.added.length - 1].end).trim()
    if (!/\p{L}/u.test(word) || word.length < 2 || word.length > 60) continue
    if (notAWord(word)) continue
    const heardLower = heard.toLowerCase()
    const wordLower = word.toLowerCase()
    if (seen.has(wordLower)) continue
    if (heardLower === wordLower.replace(/\s+/g, ' ')) {
      // Only the casing changed: worth remembering when it makes a name ("convex" -> "Convex"),
      // never for a sentence that now starts with a capital.
      if (word === word.toLowerCase() || isCommon(word)) continue
      if (byWord.get(wordLower)?.word === word) continue
      seen.add(wordLower)
      out.push({ heard, word, kind: byWord.has(wordLower) ? 'alias' : 'add' })
    } else {
      if (isCommon(word) && word === word.toLowerCase()) continue
      if (!resembles(heard, word)) continue
      const entry = byWord.get(wordLower)
      if (entry) {
        // Already known: only a new mis-hearing is news.
        if (byVariant.get(heardLower) === entry) continue
        if (byWord.has(heardLower)) continue
        seen.add(wordLower)
        out.push({ heard, word: entry.word, kind: 'alias' })
      } else {
        seen.add(wordLower)
        out.push({ heard, word, kind: 'add' })
      }
    }
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out
}

export interface EditedSpan {
  /** What Murmur typed (widened to whole words when the edit reached past it). */
  original: string
  /** The same span now. */
  edited: string
}

/**
 * Where the user edited the dictation inside a field. `before` is the field's text right after
 * Murmur typed into it, with the dictation at `[start, end)`; `after` is the field's text now.
 * Returns the dictation's span before and after the edit, or null when nothing changed or the edit
 * was elsewhere in the field (text typed before or after the dictation is not a correction of it).
 */
export function editedSpan(
  before: string,
  after: string,
  start: number,
  end: number
): EditedSpan | null {
  if (before === after) return null
  if (start < 0 || end > before.length || start >= end) return null
  let p = 0
  const maxP = Math.min(before.length, after.length)
  while (p < maxP && before[p] === after[p]) p++
  let s = 0
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  )
    s++
  const changeStart = p
  const changeEnd = before.length - s
  // The change has to touch the dictation; a pure insertion right at either edge is the user
  // continuing to type, not correcting.
  if (changeEnd <= start || changeStart >= end) {
    if (!(changeStart === changeEnd && changeStart > start && changeStart < end)) return null
  }
  const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}'’_.-]/u.test(c)
  let from = Math.min(start, changeStart)
  let to = Math.max(end, changeEnd)
  while (from > 0 && isWord(before[from - 1])) from--
  while (to < before.length && isWord(before[to])) to++
  const delta = after.length - before.length
  return { original: before.slice(from, to), edited: after.slice(from, to + delta) }
}
