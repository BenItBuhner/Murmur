import type { LlmFreedom } from '@shared/settings'
import { fixPunctuationSpacing, normalizeWhitespace } from './format'
import { spokenNumberValue } from './numbers'
import { QUESTION_START, countWords, editDistance, isQuestion } from './util'

/**
 * Trust, but verify. The model's answer goes through three gates:
 *   1. cleanLlmOutput   strips reasoning tags, fences, quotes, labels, markdown and commentary
 *   2. sanitizeLlmOutput coarse checks: empty, chatty, answered the question, wildly different
 *   3. reviewLlmEdits    a word-level diff against the deterministic text; every edit is judged by
 *                        the freedom level and anything unjustified is reverted to the speaker's words
 * The result is the model's polish with the user's content guaranteed: names, numbers and points
 * survive even when a small model gets creative.
 */

// ---- 1. cleaning ---------------------------------------------------------------------------

const THINK_BLOCK = /<(think|thinking|reasoning|analysis|scratchpad)>[\s\S]*?<\/\1>\s*/gi
const UNTERMINATED_THINK = /^<(?:think|thinking|reasoning|analysis|scratchpad)>[\s\S]*$/i
const LABEL_PREFIX =
  /^(?:(?:here(?:'s| is) |this is )?(?:the |your |my )?(?:cleaned(?:[- ]up)?|formatted|polished|final|corrected|edited|revised|fixed|rewritten|improved)(?: up)?(?: text| version| transcript| dictation| sentence| output)?|output|result|text|transcript|answer|response)\s*:\s*\n?/i
const COMMENTARY_LINE =
  /^(?:let me know|hope (?:this|that) helps|i(?:'ve| have)? (?:cleaned|removed|fixed|corrected|kept|changed|also|made|applied)|note:|notes:|changes(?: made)?:|i removed|i corrected|i changed|here(?:'s| is) (?:the|your|a)|this (?:version|text|keeps|removes)|the (?:cleaned|corrected|revised) (?:text|version)|\(?(?:no|nothing) (?:changes?|to (?:change|clean))|feel free)/i

export function cleanLlmOutput(output: string, raw: string): string {
  let text = output.replace(/\r\n?/g, '\n')
  text = text.replace(THINK_BLOCK, '')
  if (UNTERMINATED_THINK.test(text.trim())) return ''
  text = text.trim()
  // ```lang\n...\n``` or ``` ... ```
  const fence = /^```[a-z]*\n?([\s\S]*?)\n?```$/i.exec(text)
  if (fence) text = fence[1].trim()
  text = text.replace(LABEL_PREFIX, '').trim()
  if (/^["“”'‘’].*["“”'‘’]$/s.test(text) && !/^["“”'‘’]/.test(raw.trim()))
    text = text.slice(1, -1).trim()
  // Markdown the speaker never asked for.
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  if (!raw.includes('`')) text = text.replace(/`([^`\n]+)`/g, '$1')
  // A closing remark on its own line(s) at the end.
  const lines = text.split('\n')
  while (
    lines.length > 1 &&
    (COMMENTARY_LINE.test(lines[lines.length - 1].trim()) || lines[lines.length - 1].trim() === '')
  ) {
    lines.pop()
  }
  // The same at the top, when followed by a blank line.
  if (lines.length > 2 && COMMENTARY_LINE.test(lines[0].trim()) && lines[1].trim() === '')
    lines.splice(0, 2)
  text = lines.join('\n').trim()
  text = text.replace(LABEL_PREFIX, '').trim()
  return text
}

// ---- 2. coarse guard -----------------------------------------------------------------------

const CHATTY_PREFIX =
  /^(?:sure|certainly|of course|absolutely|here(?:'s| is| are)|i(?:'m| am) sorry|as an ai|i can(?:'t|not)|the cleaned|cleaned text|here you go|i'd be happy|i (?:have|'ve) (?:cleaned|removed)|okay,? here)\b/i
const PROMPT_ECHO =
  /\b(?:output only the cleaned text|you are the cleanup stage|speech recognizer transcribed|^never:|^fix:|^layout:)/im

export interface SanitizeResult {
  ok: boolean
  text: string
  reason?: string
}

/**
 * Guard rails for the model output. The failure mode we care about is the model treating the
 * dictation as a question and answering it, or wrapping the result in commentary. Anything
 * rejected here makes the caller fall back to the deterministic pipeline output.
 */
export function sanitizeLlmOutput(output: string, raw: string): SanitizeResult {
  const text = cleanLlmOutput(output, raw)
  if (!text) return { ok: false, text: '', reason: 'empty' }
  const rawTrim = raw.trim()
  if (CHATTY_PREFIX.test(text) && !CHATTY_PREFIX.test(rawTrim))
    return { ok: false, text, reason: 'chatty' }
  if (PROMPT_ECHO.test(text) && !PROMPT_ECHO.test(rawTrim))
    return { ok: false, text, reason: 'echo' }

  const rawWords = countWords(raw)
  const outWords = countWords(text)
  if (rawWords >= 6) {
    const ratio = outWords / rawWords
    if (ratio < 0.35) return { ok: false, text, reason: 'too-short' }
    if (ratio > 2.2) return { ok: false, text, reason: 'too-long' }
  } else if (outWords > rawWords + 6) {
    return { ok: false, text, reason: 'too-long' }
  }

  // A dictated question must still be a question; an answer is the classic failure.
  if (isQuestion(rawTrim) && rawWords >= 3 && !text.includes('?')) {
    const firstOut = text.split(/(?<=[.!?])\s+/)[0] ?? text
    if (!QUESTION_START.test(firstOut)) return { ok: false, text, reason: 'answered' }
  }

  // The rewrite must share most of its content words with the transcript.
  if (rawWords >= 5) {
    const rawSet = contentWords(raw)
    const outSet = contentWords(text)
    if (rawSet.size >= 3 && outSet.size > 0) {
      let shared = 0
      for (const w of outSet) if (rawSet.has(w)) shared++
      const overlap = shared / outSet.size
      if (overlap < 0.45) return { ok: false, text, reason: 'diverged' }
    }
  }
  return { ok: true, text }
}

function contentWords(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    if (w.length >= 3) out.add(w.replace(/^'+|'+$/g, ''))
  }
  return out
}

// ---- 3. edit review ------------------------------------------------------------------------

export type TokenKind = 'word' | 'punct' | 'newline' | 'marker'

export interface DiffToken {
  text: string
  /** Comparison key: lower-cased, straight apostrophes, single number words as digits. */
  key: string
  kind: TokenKind
  /** True when whitespace preceded the token in the source. */
  spaced: boolean
}

const SMALL_NUMBERS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000'
}

const TOKEN_RE = /\n+|[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu

export function tokenizeForDiff(text: string): DiffToken[] {
  const out: DiffToken[] = []
  let atLineStart = true
  let last = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0]
    const spaced = m.index > last && /\s/.test(text.slice(last, m.index))
    last = m.index + raw.length
    if (raw.startsWith('\n')) {
      out.push({ text: raw.length > 1 ? '\n\n' : '\n', key: '\n', kind: 'newline', spaced: false })
      atLineStart = true
      continue
    }
    let kind: TokenKind
    if (/^[\p{L}\p{N}]/u.test(raw)) {
      const next = text[last] ?? ''
      kind =
        atLineStart && /^\d{1,3}$/.test(raw) && (next === '.' || next === ')') ? 'marker' : 'word'
    } else {
      kind =
        atLineStart && /^[-•*–—·]$/.test(raw) && /\s/.test(text[last] ?? '') ? 'marker' : 'punct'
    }
    const lower = raw.toLowerCase().replace(/’/g, "'").replace(/\.$/, '')
    const key = kind === 'word' ? (SMALL_NUMBERS[lower] ?? lower) : kind === 'marker' ? '#' : raw
    out.push({ text: raw, key, kind, spaced })
    atLineStart = kind === 'marker' || (atLineStart && kind === 'punct')
  }
  return out
}

export interface Hunk {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/** Longest-common-subsequence alignment of two token lists (by key). Returns the non-equal hunks. */
export function diffTokens(a: DiffToken[], b: DiffToken[]): Hunk[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const dp = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i].key === b[j].key
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  let open: Hunk | null = null
  const close = (): void => {
    if (open) {
      open.aEnd = i
      open.bEnd = j
      hunks.push(open)
      open = null
    }
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i].key === b[j].key) {
      close()
      i++
      j++
    } else {
      if (!open) open = { aStart: i, aEnd: i, bStart: j, bEnd: j }
      if (j < m && (i >= n || dp[i * width + j + 1] >= dp[(i + 1) * width + j])) j++
      else i++
    }
  }
  close()
  return hunks
}

export interface ReviewPolicy {
  freedom: LlmFreedom
  /** Words the deterministic stage would drop as noise; their deletion is always fine. */
  droppable: ReadonlySet<string>
  /** Dictionary terms (lower-cased); they must survive unless the model spelled them canonically. */
  protectedTerms: ReadonlySet<string>
  /** The model may add line breaks and list markers. */
  allowNewLines: boolean
  /** Line breaks in the deterministic text are final. */
  preserveLayout: boolean
}

export interface ReviewOutcome {
  text: string
  accepted: number
  reverted: number
}

const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'that',
  'this',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'will',
  'would',
  'can',
  'could',
  'should',
  'not',
  'if',
  'so',
  'as',
  'with',
  'by',
  'from',
  'up',
  'out',
  'about',
  'then',
  'than',
  'there',
  'here',
  'am',
  "i'm",
  "it's",
  "that's",
  'please'
])

const DISCOURSE = new Set([
  'so',
  'like',
  'okay',
  'ok',
  'yeah',
  'yep',
  'well',
  'right',
  'anyway',
  'anyways',
  'basically',
  'actually',
  'literally',
  'honestly',
  'just',
  'really',
  'and',
  'then',
  'um',
  'uh',
  'uhm',
  'umm',
  'erm',
  'er',
  'ah',
  'hmm',
  'mm',
  'mhm',
  'hm',
  'oh'
])

const CORRECTION_MARKERS = new Set([
  'no',
  'sorry',
  'wait',
  'mean',
  'rather',
  'correction',
  'scratch',
  'that',
  'actually'
])

/** Words whose loss changes nothing but emphasis; the only single-word deletions balanced accepts. */
const INTENSIFIERS = new Set([
  'very',
  'really',
  'just',
  'quite',
  'pretty',
  'kind',
  'sort',
  'of',
  'definitely',
  'totally',
  'obviously',
  'simply',
  'basically',
  'actually',
  'literally',
  'honestly',
  'like',
  'so',
  'then',
  'also',
  'anyway'
])
/** Words whose loss flips the meaning; never deletable, never swappable for free. */
const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  'none',
  'nothing',
  'nobody',
  'neither',
  'nor',
  'without',
  "n't",
  'cannot'
])

/** Contractions and spoken shortenings; either direction is a normalization, not a rewrite. */
const NORMALIZE_ALL: Array<[string, string]> = [
  ["i'm", 'i am'],
  ["don't", 'do not'],
  ["doesn't", 'does not'],
  ["didn't", 'did not'],
  ["can't", 'cannot'],
  ["can't", 'can not'],
  ["won't", 'will not'],
  ["it's", 'it is'],
  ["that's", 'that is'],
  ["there's", 'there is'],
  ["what's", 'what is'],
  ["let's", 'let us'],
  ["we're", 'we are'],
  ["they're", 'they are'],
  ["you're", 'you are'],
  ["isn't", 'is not'],
  ["aren't", 'are not'],
  ["wasn't", 'was not'],
  ["weren't", 'were not'],
  ["haven't", 'have not'],
  ["hasn't", 'has not'],
  ["hadn't", 'had not'],
  ["wouldn't", 'would not'],
  ["couldn't", 'could not'],
  ["shouldn't", 'should not'],
  ["i've", 'i have'],
  ["we've", 'we have'],
  ["you've", 'you have'],
  ["they've", 'they have'],
  ["i'll", 'i will'],
  ["we'll", 'we will'],
  ["you'll", 'you will'],
  ["he'll", 'he will'],
  ["she'll", 'she will'],
  ["they'll", 'they will'],
  ["it'll", 'it will'],
  ["i'd", 'i would'],
  ["we'd", 'we would'],
  ["you'd", 'you would'],
  ["he's", 'he is'],
  ["she's", 'she is'],
  ['gonna', 'going to'],
  ['wanna', 'want to'],
  ['gotta', 'got to'],
  ['gotta', 'have to'],
  ['kinda', 'kind of'],
  ['sorta', 'sort of'],
  ['cause', 'because'],
  ["'cause", 'because'],
  ['til', 'until'],
  ['till', 'until'],
  ['ok', 'okay'],
  ['e-mail', 'email'],
  ['alright', 'all right']
]
const NORMALIZE_BALANCED: Array<[string, string]> = [
  ['yeah', 'yes'],
  ['yep', 'yes'],
  ['yup', 'yes'],
  ['nope', 'no'],
  ['nah', 'no'],
  ['thanks', 'thank you'],
  ['dunno', "don't know"],
  ['lemme', 'let me'],
  ['gimme', 'give me']
]

const HOMOPHONES: string[][] = [
  ['their', 'there', "they're"],
  ['to', 'too', 'two'],
  ['your', "you're"],
  ['its', "it's"],
  ['then', 'than'],
  ['affect', 'effect'],
  ['wear', 'where', 'were'],
  ['here', 'hear'],
  ['know', 'no'],
  ['write', 'right'],
  ['by', 'buy', 'bye'],
  ['are', 'our'],
  ['of', 'have'],
  ['whether', 'weather'],
  ['accept', 'except'],
  ['loose', 'lose'],
  ['principal', 'principle'],
  ['complement', 'compliment'],
  ['peace', 'piece'],
  ['brake', 'break'],
  ['sea', 'see'],
  ['for', 'four'],
  ['one', 'won'],
  ['ate', 'eight'],
  ['new', 'knew'],
  ['through', 'threw'],
  ['weak', 'week'],
  ['which', 'witch'],
  ['whole', 'hole'],
  ['hour', 'our'],
  ['aloud', 'allowed'],
  ['bare', 'bear'],
  ['sale', 'sail'],
  ['plain', 'plane'],
  ['role', 'roll'],
  ['site', 'sight', 'cite'],
  ['some', 'sum'],
  ['wait', 'weight'],
  ['waist', 'waste'],
  ['way', 'weigh'],
  ['a', 'uh'],
  ['who', 'whose', "who's"],
  ['past', 'passed'],
  ['lead', 'led'],
  ['aloud', 'allowed'],
  ['dear', 'deer'],
  ['fair', 'fare'],
  ['made', 'maid'],
  ['meet', 'meat'],
  ['pair', 'pear'],
  ['read', 'red'],
  ['son', 'sun'],
  ['flour', 'flower'],
  ['be', 'bee']
]
const HOMOPHONE_GROUP = new Map<string, number>()
HOMOPHONES.forEach((group, i) => group.forEach((w) => HOMOPHONE_GROUP.set(w, i)))

const GRAMMAR_GROUPS: string[][] = [
  ['was', 'were'],
  ['is', 'are', 'am'],
  ['a', 'an'],
  ['has', 'have'],
  ['do', 'does'],
  ["don't", "doesn't"],
  ['this', 'these'],
  ['that', 'those'],
  ['him', 'he'],
  ['me', 'i'],
  ['them', 'they'],
  ['us', 'we'],
  ['who', 'whom'],
  ['less', 'fewer'],
  ['much', 'many'],
  ['good', 'well'],
  ['go', 'goes', 'went', 'gone', 'going'],
  ['be', 'been', 'being', 'is', 'are', 'was', 'were'],
  ['have', 'has', 'had', 'having'],
  ['do', 'does', 'did', 'done', 'doing'],
  ['take', 'takes', 'took', 'taken'],
  ['make', 'makes', 'made'],
  ['come', 'comes', 'came'],
  ['see', 'sees', 'saw', 'seen'],
  ['get', 'gets', 'got', 'gotten'],
  ['say', 'says', 'said'],
  ['think', 'thinks', 'thought'],
  ['know', 'knows', 'knew', 'known'],
  ['give', 'gives', 'gave', 'given'],
  ['find', 'finds', 'found'],
  ['tell', 'tells', 'told'],
  ['send', 'sends', 'sent'],
  ['run', 'runs', 'ran'],
  ['buy', 'buys', 'bought'],
  ['bring', 'brings', 'brought'],
  ['write', 'writes', 'wrote', 'written'],
  ['speak', 'speaks', 'spoke', 'spoken'],
  ['begin', 'begins', 'began', 'begun'],
  ['choose', 'chooses', 'chose', 'chosen'],
  ['lay', 'lie', 'laid', 'lain']
]
const GRAMMAR_GROUP = new Map<string, Set<number>>()
GRAMMAR_GROUPS.forEach((group, i) =>
  group.forEach((w) => {
    if (!GRAMMAR_GROUP.has(w)) GRAMMAR_GROUP.set(w, new Set())
    GRAMMAR_GROUP.get(w)!.add(i)
  })
)

function expand(words: string, table: Array<[string, string]>): string {
  let s = ` ${words} `
  for (const [from, to] of table) s = s.replace(new RegExp(` ${escape(from)} `, 'g'), ` ${to} `)
  return s.trim().replace(/\s+/g, ' ')
}
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function sameHomophoneGroup(a: string, b: string): boolean {
  const ga = HOMOPHONE_GROUP.get(a)
  return ga !== undefined && ga === HOMOPHONE_GROUP.get(b)
}
function sameGrammarGroup(a: string, b: string): boolean {
  const ga = GRAMMAR_GROUP.get(a)
  const gb = GRAMMAR_GROUP.get(b)
  if (!ga || !gb) return false
  for (const g of ga) if (gb.has(g)) return true
  return false
}

const SUFFIXES = ['ing', 'ed', 'es', 's', 'ly', 'er', 'est', "'s", 'd']
function stem(w: string): string {
  for (const s of SUFFIXES)
    if (w.length > s.length + 2 && w.endsWith(s)) return w.slice(0, -s.length)
  return w
}
function sameStem(a: string, b: string): boolean {
  if (a === b) return true
  const sa = stem(a)
  const sb = stem(b)
  return (
    sa.length >= 3 &&
    (sa === sb ||
      (Math.abs(sa.length - sb.length) <= 1 && (sa.startsWith(sb) || sb.startsWith(sa))))
  )
}

function isSpellingFix(a: string, b: string): boolean {
  if (!/^[\p{L}'’-]+$/u.test(a) || !/^[\p{L}'’-]+$/u.test(b)) return false
  const len = Math.max(a.length, b.length)
  if (len < 3) return false
  const max = Math.max(1, Math.floor(len / 4))
  return editDistance(a, b, max) <= max
}

const hasDigit = (s: string): boolean => /\p{N}/u.test(s)
const isCapitalized = (s: string): boolean => /^\p{Lu}/u.test(s)

/** "twenty five dollars" and "$25" are the same number; units and currency words are ignored. */
function numericValue(tokens: DiffToken[]): number | null {
  const words = tokens
    .filter((t) => t.kind === 'word' || /^[$€£%]$/.test(t.text))
    .map((t) => t.text.toLowerCase())
    .filter((w) => !/^(?:dollars?|euros?|pounds?|bucks|cents?|percent|[$€£%])$/.test(w))
  if (!words.length) return null
  return spokenNumberValue(words.join(' '))
}

interface Judgement {
  accept: boolean
  why: string
}

function judge(a: DiffToken[], b: DiffToken[], hunk: Hunk, policy: ReviewPolicy): Judgement {
  const aTok = a.slice(hunk.aStart, hunk.aEnd)
  const bTok = b.slice(hunk.bStart, hunk.bEnd)
  const aWords = aTok.filter((t) => t.kind === 'word')
  const bWords = bTok.filter((t) => t.kind === 'word')
  const aKeys = aWords.map((t) => t.key)
  const bKeys = bWords.map((t) => t.key)
  const level = policy.freedom === 'strict' ? 0 : policy.freedom === 'balanced' ? 1 : 2

  // Layout changes are judged first, whatever words travel with them.
  const aNl = aTok.some((t) => t.kind === 'newline')
  const bNl = bTok.some((t) => t.kind === 'newline' || t.kind === 'marker')
  if (aNl && !bNl && policy.preserveLayout) return { accept: false, why: 'layout-removed' }
  if (bNl && !aNl && !policy.allowNewLines) return { accept: false, why: 'layout-added' }
  if (!aWords.length && !bWords.length) return { accept: true, why: 'punctuation' }
  // Deleting across a sentence boundary drops a whole thought.
  if (!bWords.length && aTok.some((t) => /^[.!?]$/.test(t.text)) && aWords.length > 1)
    return { accept: false, why: 'sentence-deleted' }

  const protectedIn = (keys: string[]): boolean =>
    keys.some((k) => policy.protectedTerms.has(k) || hasDigit(k))
  const properNouns = (toks: DiffToken[], startIdx: number, src: DiffToken[]): string[] =>
    toks
      .filter((t, i) => {
        if (!isCapitalized(t.text) || t.text.length < 2) return false
        // Sentence-initial capitals are not proper nouns.
        const prev = src[startIdx + i - 1]
        return !!prev && prev.kind !== 'newline' && !/[.!?]/.test(prev.text)
      })
      .map((t) => t.key)

  // Deletion.
  if (!bWords.length) {
    const prevKey = a[hunk.aStart - 1]?.key
    const nextKey = a[hunk.aEnd]?.key
    const droppable = aWords.every(
      (t, i) =>
        policy.droppable.has(t.key) ||
        DISCOURSE.has(t.key) ||
        t.key === prevKey ||
        t.key === nextKey ||
        (i > 0 && t.key === aWords[i - 1].key)
    )
    if (droppable) return { accept: true, why: 'noise' }
    const last = aKeys[aKeys.length - 1]
    if (
      aWords.length <= 6 &&
      CORRECTION_MARKERS.has(last) &&
      !(aWords.length === 1 && last === 'no')
    )
      return { accept: true, why: 'self-correction' }
    // "no wait", "I mean" inside the span followed by nothing else meaningful.
    if (
      aWords.length <= 6 &&
      aKeys.some((k) => k === 'mean' || k === 'sorry' || k === 'scratch' || k === 'correction')
    )
      return { accept: true, why: 'self-correction' }
    if (protectedIn(aKeys)) return { accept: false, why: 'protected-deleted' }
    if (aKeys.some((k) => NEGATIONS.has(k) || /n't$/.test(k)))
      return { accept: false, why: 'negation-deleted' }
    const nouns = properNouns(aTok, hunk.aStart, a)
    if (nouns.length) return { accept: false, why: 'name-deleted' }
    const plain = aWords.filter((t) => !DISCOURSE.has(t.key) && !policy.droppable.has(t.key))
    if (level >= 1 && plain.every((t) => INTENSIFIERS.has(t.key)))
      return { accept: true, why: 'intensifier' }
    if (level >= 2 && plain.length <= 2) return { accept: true, why: 'smoothing' }
    return { accept: false, why: 'content-deleted' }
  }

  // Insertion.
  if (!aWords.length) {
    if (protectedIn(bKeys) && !bKeys.every((k) => policy.protectedTerms.has(k)))
      return { accept: false, why: 'number-added' }
    const nouns = properNouns(bTok, hunk.bStart, b)
    if (nouns.length && !nouns.every((k) => policy.protectedTerms.has(k)))
      return { accept: false, why: 'name-added' }
    if (level >= 1 && bWords.length <= 2 && bKeys.every((k) => FUNCTION_WORDS.has(k)))
      return { accept: true, why: 'function-word' }
    if (level >= 2 && bWords.length <= 3) return { accept: true, why: 'smoothing' }
    return { accept: false, why: 'words-added' }
  }

  // Replacement.
  const aJoined = aKeys.join(' ')
  const bJoined = bKeys.join(' ')
  if (aJoined === bJoined) return { accept: true, why: 'punctuation' }
  const squash = (s: string): string => s.replace(/[\s'’.-]/g, '')
  if (squash(aJoined) === squash(bJoined)) return { accept: true, why: 'spacing' }
  if (expand(aJoined, NORMALIZE_ALL) === expand(bJoined, NORMALIZE_ALL))
    return { accept: true, why: 'contraction' }
  if (
    level >= 1 &&
    expand(expand(aJoined, NORMALIZE_ALL), NORMALIZE_BALANCED) ===
      expand(expand(bJoined, NORMALIZE_ALL), NORMALIZE_BALANCED)
  )
    return { accept: true, why: 'informal' }
  const aNum = numericValue(aTok)
  const bNum = numericValue(bTok)
  if (aNum !== null && bNum !== null && aNum === bNum) return { accept: true, why: 'number' }
  if (aNum !== null && bNum !== null && aNum !== bNum)
    return { accept: false, why: 'number-changed' }
  // "cube control" -> "kubectl": the model applied the user's dictionary.
  if (bKeys.every((k) => policy.protectedTerms.has(k)) && aWords.length <= 4)
    return { accept: true, why: 'dictionary' }

  // Pairwise checks when the word counts line up.
  if (aWords.length === bWords.length) {
    let ok = true
    let why = 'spelling'
    for (let i = 0; i < aKeys.length && ok; i++) {
      const x = aKeys[i]
      const y = bKeys[i]
      if (x === y) continue
      if (policy.protectedTerms.has(y) && !policy.protectedTerms.has(x)) continue // canonical spelling
      if (sameHomophoneGroup(x, y) || isSpellingFix(x, y)) continue
      if (level >= 1 && (sameGrammarGroup(x, y) || sameStem(x, y))) {
        why = 'grammar'
        continue
      }
      ok = false
    }
    if (ok) return { accept: true, why }
  }
  // Same words in a different order.
  if (
    level >= 1 &&
    aKeys.length === bKeys.length &&
    [...aKeys].sort().join(' ') === [...bKeys].sort().join(' ')
  )
    return { accept: true, why: 'reorder' }
  // "a apple" -> "an apple" style: one side is the other plus a function word.
  if (level >= 1 && Math.abs(aKeys.length - bKeys.length) === 1) {
    const [longer, shorter] = aKeys.length > bKeys.length ? [aKeys, bKeys] : [bKeys, aKeys]
    for (let i = 0; i < longer.length; i++) {
      const without = [...longer.slice(0, i), ...longer.slice(i + 1)]
      if (FUNCTION_WORDS.has(longer[i]) && without.join(' ') === shorter.join(' '))
        return { accept: true, why: 'function-word' }
    }
  }

  if (level >= 2) {
    // A negation may move but never appear or disappear.
    const negA = aKeys.filter((k) => NEGATIONS.has(k) || /n't$/.test(k)).length
    const negB = bKeys.filter((k) => NEGATIONS.has(k) || /n't$/.test(k)).length
    if (negA !== negB) return { accept: false, why: 'negation-changed' }
    const aProtected = aKeys.filter((k) => policy.protectedTerms.has(k) || hasDigit(k))
    const bProtected = bKeys.filter((k) => policy.protectedTerms.has(k) || hasDigit(k))
    const keepsProtected =
      aProtected.every((k) => bKeys.includes(k)) && bProtected.every((k) => aKeys.includes(k))
    const aNouns = properNouns(aTok, hunk.aStart, a)
    const bNouns = properNouns(bTok, hunk.bStart, b)
    const keepsNouns =
      aNouns.every((k) => bKeys.includes(k)) &&
      bNouns.every((k) => aKeys.includes(k) || policy.protectedTerms.has(k))
    if (keepsProtected && keepsNouns && aWords.length <= 4 && bWords.length <= 4)
      return { accept: true, why: 'smoothing' }
  }
  return { accept: false, why: 'rewrite' }
}

export interface ReviewDetail {
  hunk: Hunk
  accept: boolean
  why: string
  from: string
  to: string
}

export interface EditReview extends ReviewOutcome {
  details: ReviewDetail[]
}

const MAX_TOKENS = 1400

/**
 * Merge the model's output with the deterministic text: accepted hunks come from the model,
 * reverted hunks keep the deterministic wording. Casing of a word right after a reverted hunk
 * follows the deterministic side too (the model may have capitalized it only because it dropped
 * the word before).
 */
export function reviewLlmEdits(light: string, candidate: string, policy: ReviewPolicy): EditReview {
  const a = tokenizeForDiff(light)
  const b = tokenizeForDiff(candidate)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS)
    return { text: candidate, accepted: 0, reverted: 0, details: [] }
  const hunks = diffTokens(a, b)
  const details: ReviewDetail[] = []
  let accepted = 0
  let reverted = 0
  const out: string[] = []
  let i = 0
  let j = 0
  let afterRevert = false

  const emit = (t: DiffToken, useSpace: boolean): void => {
    if (t.kind === 'newline') {
      out.push(t.text)
      return
    }
    const prev = out[out.length - 1]
    const needSpace =
      useSpace &&
      out.length > 0 &&
      !prev.endsWith('\n') &&
      !/^[,.;:!?)\]%]$/.test(t.text) &&
      !/[([]$/.test(prev)
    out.push(needSpace ? ` ${t.text}` : t.text)
  }

  /** Same word, different case: the deterministic side knows whether it started a sentence. */
  const withCasing = (tok: DiffToken, from: DiffToken): DiffToken =>
    tok.key === from.key &&
    tok.kind === 'word' &&
    tok.text !== from.text &&
    tok.text.toLowerCase() === from.text.toLowerCase()
      ? { ...tok, text: from.text }
      : tok

  for (const h of [...hunks, null]) {
    const stopA = h ? h.aStart : a.length
    const stopB = h ? h.bStart : b.length
    // Equal run.
    while (i < stopA && j < stopB) {
      const tokB = b[j]
      const tokA = a[i]
      emit(afterRevert ? withCasing(tokB, tokA) : tokB, tokB.spaced || tokA.spaced)
      afterRevert = false
      i++
      j++
    }
    if (!h) break
    const verdict = judge(a, b, h, policy)
    details.push({
      hunk: h,
      accept: verdict.accept,
      why: verdict.why,
      from: a
        .slice(h.aStart, h.aEnd)
        .map((t) => t.text)
        .join(' '),
      to: b
        .slice(h.bStart, h.bEnd)
        .map((t) => t.text)
        .join(' ')
    })
    if (verdict.accept) {
      accepted++
      for (let k = h.bStart; k < h.bEnd; k++) emit(b[k], b[k].spaced || k === h.bStart)
      afterRevert = false
    } else {
      reverted++
      const aSide = a.slice(h.aStart, h.aEnd)
      const bSide = b.slice(h.bStart, h.bEnd)
      // The model may have capitalized its first word because it now opens the sentence; keep that.
      const bFirst = bSide.find((t) => t.kind === 'word')
      for (let k = 0; k < aSide.length; k++) {
        let tok = aSide[k]
        if (
          k === 0 &&
          bFirst &&
          tok.kind === 'word' &&
          isCapitalized(bFirst.text) &&
          !isCapitalized(tok.text)
        )
          tok = { ...tok, text: tok.text[0].toUpperCase() + tok.text.slice(1) }
        emit(tok, tok.spaced || k === 0)
      }
      // Sentence punctuation the model added at the end of a reverted word span still applies.
      const aWordsOnly = aSide.length > 0 && aSide.every((t) => t.kind === 'word')
      const trailing: DiffToken[] = []
      for (
        let k = bSide.length - 1;
        k >= 0 && bSide[k].kind === 'punct' && /^[.!?,;:]$/.test(bSide[k].text);
        k--
      )
        trailing.unshift(bSide[k])
      if (aWordsOnly && trailing.length) for (const t of trailing) emit(t, false)
      afterRevert = true
    }
    i = h.aEnd
    j = h.bEnd
  }
  const text = normalizeWhitespace(fixPunctuationSpacing(out.join('')))
  return { text, accepted, reverted, details }
}

export interface LlmReview {
  outcome: 'used' | 'partial' | 'rejected'
  text: string
  reason?: string
  accepted: number
  reverted: number
  details: ReviewDetail[]
}

/** All three gates. `light` is the deterministic pipeline output the model was asked to polish. */
export function reviewLlmOutput(output: string, light: string, policy: ReviewPolicy): LlmReview {
  const coarse = sanitizeLlmOutput(output, light)
  if (!coarse.ok)
    return {
      outcome: 'rejected',
      text: coarse.text,
      reason: coarse.reason,
      accepted: 0,
      reverted: 0,
      details: []
    }
  const review = reviewLlmEdits(light.trim(), coarse.text, policy)
  if (review.reverted >= 3 && review.reverted > review.accepted) {
    return { outcome: 'rejected', reason: 'rewrite', ...review }
  }
  return { outcome: review.reverted ? 'partial' : 'used', ...review }
}
