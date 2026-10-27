/**
 * Joining the pieces of a long dictation that were transcribed (and formatted) separately.
 *
 * A piece ends wherever the speaker paused, which is often mid-sentence. Each piece comes back
 * looking like a complete text: a period at its end, a capital at its start, sometimes the word
 * at the cut heard twice ("would otherwise. Otherwise, we"). joinSeam repairs that one boundary
 * and leaves the rest of both texts alone.
 */

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

/**
 * Words that almost never end a sentence: articles, prepositions, conjunctions, auxiliaries,
 * determiners, subject pronouns and intensifiers. A piece ending in one was cut mid-sentence.
 */
const CONTINUATION = new Set(
  (
    'a an the as of to and or but nor so if than that which who whose with without for from in ' +
    'on at by into onto about over under after before between through during like my your our ' +
    'their his her its this these those some any every each very really literally just quite ' +
    'almost also would could should will can may might must shall is are was were be been being ' +
    'am do does did have has had not because since while when where whether although though ' +
    "until unless even more most less such we they he she i'm we're they're you're i've we've " +
    "they've i'd we'd they'd i'll we'll they'll it's there's that's gonna wanna gotta kind sort " +
    'whatever whichever whoever both either neither'
  ).split(/\s+/)
)

const ARTICLES = new Set(['a', 'an', 'the'])
/** Words that keep their capital wherever they fall. */
const ALWAYS_CAPITAL = /^(I|I['’](m|ll|ve|d))$/

interface Word {
  key: string
  start: number
  end: number
  text: string
}

function words(s: string): Word[] {
  const out: Word[] = []
  for (const m of s.matchAll(WORD_RE))
    out.push({
      key: m[0].toLowerCase().replace(/’/g, "'"),
      start: m.index,
      end: m.index + m[0].length,
      text: m[0]
    })
  return out
}

/** How many words each side of a seam are searched for a repeat (a piece can echo a whole clause). */
export const SEAM_WINDOW = 20
/** Words at the end of the text before that an echo may stop short of (the model dropped or changed them). */
const ECHO_SLACK = 3

/** Same word, or the same word with and without a contraction ("it" / "it's"). */
function sameKey(a: string, b: string): boolean {
  if (a === b) return true
  const base = (k: string): string => k.replace(/'(s|re|ll|ve|d|m|t)$/u, '')
  return Math.min(a.length, b.length) >= 2 && base(a) === base(b)
}

/**
 * Does `b` start with the `k` words of `a` that end at index `aEnd` (exclusive)? Runs of 8 or more
 * words tolerate one changed word (a near-exact echo); the first and last words must agree.
 */
function runMatches(a: readonly Word[], aEnd: number, b: readonly Word[], k: number): boolean {
  if (k > aEnd || k > b.length) return false
  const from = aEnd - k
  // The run's last word must agree exactly: "it" then "it's" is the next word starting, not an echo.
  if (!sameKey(a[from].key, b[0].key) || a[aEnd - 1].key !== b[k - 1].key) return false
  let miss = 0
  const allowed = k >= 8 ? 1 : 0
  for (let i = 0; i < k; i++) {
    const same = k >= 4 ? sameKey(a[from + i].key, b[i].key) : a[from + i].key === b[i].key
    if (!same && ++miss > allowed) return false
  }
  return true
}

/**
 * The longest repeat of the end of `prev` (within its last SEAM_WINDOW words) at the start of
 * `next`: { k: words repeated, slack: words at the very end of prev after the repeated run }.
 * slack > 0 only for runs of 5+ words.
 */
function findRepeat(hw: readonly Word[], tw: readonly Word[]): { k: number; slack: number } | null {
  for (let k = Math.min(hw.length, tw.length); k >= 1; k--) {
    if (runMatches(hw, hw.length, tw, k)) {
      // One shared short word is an echo only if it is a function word ("to to", "the the"),
      // which nobody doubles on purpose; "it it" or "no no" may have been said.
      if (k >= 2 || tw[0].key.length >= 4 || CONTINUATION.has(tw[0].key)) return { k, slack: 0 }
    }
  }
  for (let slack = 1; slack <= ECHO_SLACK; slack++)
    for (let k = Math.min(hw.length - slack, tw.length); k >= 5; k--)
      if (runMatches(hw, hw.length - slack, tw, k)) return { k, slack }
  return null
}

export interface SeamJoin {
  text: string
  /** Words dropped from the start of `next` because `prev` already ended with them. */
  deduped: number
  /** A period or ellipsis at the end of `prev` was removed and `next` continued in lower case. */
  joined: boolean
}

/** Is this word capitalized somewhere other than a sentence start, so likely a name? */
function looksLikeName(word: string, ...texts: string[]): boolean {
  if (word.length > 1 && word === word.toUpperCase()) return true // acronym
  const re = new RegExp(
    `[\\p{L}\\p{N},;:]\\s+${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
    'u'
  )
  return texts.some((t) => re.test(t))
}

/**
 * Join two consecutive pieces of one dictation. `prev` and `next` may each be raw speech
 * recognition or formatted text.
 */
export function joinSeam(prev: string, next: string): SeamJoin {
  let h = prev.replace(/\s+$/u, '')
  let t = next.replace(/^\s+/u, '')
  if (!t) return { text: h, deduped: 0, joined: false }
  if (!h) return { text: t, deduped: 0, joined: false }

  // 1. The words at the cut heard (or echoed by the formatter) by both pieces: up to
  // SEAM_WINDOW words, near-exact for long runs, possibly stopping a few words short of prev's end.
  const hw = words(h).slice(-SEAM_WINDOW)
  let tw = words(t).slice(0, SEAM_WINDOW)
  let deduped = 0
  const rep = findRepeat(hw, tw)
  if (rep && rep.slack > 0) {
    // prev ends with a few words after the repeated run; next repeats the run and goes on. When
    // next goes on with those same words, its version is kept and prev's is dropped.
    const slackWords = hw.slice(hw.length - rep.slack)
    const after = tw.slice(rep.k, rep.k + rep.slack)
    const redone = after.length === rep.slack && slackWords.every((w, i) => sameKey(w.key, after[i].key))
    if (redone) {
      h = h.slice(0, slackWords[0].start).replace(/[\s,;:]+$/u, '')
      // Drop the run itself; next carries the rest.
    }
    t = t.slice(tw[rep.k - 1].end).replace(/^[\s,;:.!?…-]+/u, '')
    deduped = rep.k
    if (!t) return { text: h, deduped, joined: false }
    tw = words(t).slice(0, SEAM_WINDOW)
  } else if (rep) deduped = rep.k
  // "a An extra": the article at the cut heard twice, differently.
  const lastH = hw[hw.length - 1]
  if (!deduped && lastH && tw[0] && ARTICLES.has(lastH.key) && ARTICLES.has(tw[0].key)) {
    h = h.slice(0, lastH.start).replace(/\s+$/u, '')
    // Keep the capital only if the article started a sentence in prev.
    const startsSentence = !h || /[.!?…]["')\]]*$/u.test(h)
    if (!startsSentence) t = tw[0].text.toLowerCase() + t.slice(tw[0].end)
    if (!h) return { text: t, deduped: 1, joined: false }
    deduped = 1
    tw = words(t).slice(0, 8)
  } else if (deduped && !(rep && rep.slack > 0)) {
    t = t.slice(tw[deduped - 1].end).replace(/^[\s,;:.!?…-]+/u, '')
    if (!t) return { text: h, deduped, joined: false }
    tw = words(t).slice(0, SEAM_WINDOW)
  }

  // 1b. A cut mid-sentence ("…for me in this | chat? Can I…"): prev got a terminal mark it was
  // never owed, and next opens with the one or two words that finish prev's sentence, in lower
  // case, then its own mark. Those words go back before prev's mark ("in this chat?"), so neither
  // the reader nor the formatter sees a stray fragment it might move elsewhere.
  const frag = /^(\p{Ll}[\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}'’-]+)?)([.?!…]+)["')\]]*\s+(?=\p{Lu})/u.exec(t)
  const hMark = /([.?!…]+)(["')\]]*)$/u.exec(h)
  if (frag && hMark) {
    const mark = hMark[1].includes('?') || frag[2].includes('?') ? '?' : frag[2]
    h = `${h.slice(0, hMark.index)} ${frag[1]}${mark}${hMark[2]}`
    t = t.slice(frag[0].length)
    return { text: `${h} ${t}`, deduped, joined: true }
  }

  // 2. A period or ellipsis the cut put in the middle of a sentence.
  const hWords = words(h)
  const last = hWords[hWords.length - 1]
  const first = tw[0]
  const endsSoft = /(\.{2,}|…|(?<!\.)\.)["')\]]*$/u.test(h) && !/[!?]["')\]]*$/u.test(h)
  const endsBare = !/[.!?…:;,"')\]]$/u.test(h)
  const firstAtStart = first && first.start === 0
  const nextLower = firstAtStart && /^\p{Ll}/u.test(first.text)
  const midSentence =
    deduped > 0 ||
    /(\.{2,}|…)["')\]]*$/u.test(h) ||
    (last && CONTINUATION.has(last.key)) ||
    nextLower
  let joined = false
  if (firstAtStart && midSentence && (endsSoft || endsBare)) {
    if (endsSoft) h = h.replace(/(\.{2,}|…|\.)(["')\]]*)$/u, '$2')
    const keepCap =
      ALWAYS_CAPITAL.test(first.text) || looksLikeName(first.text, h, t.slice(first.end))
    if (!keepCap) t = first.text.toLowerCase() + t.slice(first.end)
    joined = endsSoft || !keepCap
  } else if (
    firstAtStart &&
    endsBare &&
    !midSentence &&
    /^\p{Lu}/u.test(first.text) &&
    !ALWAYS_CAPITAL.test(first.text) &&
    !looksLikeName(first.text, h, t.slice(first.end))
  ) {
    // 3. A bare end followed by a capital that is not a name or "I": a new sentence whose period
    // the piece left off (pieces are told to leave a possibly unfinished end unpunctuated).
    h = `${h}.`
  }
  return { text: `${h} ${t}`, deduped, joined }
}

/** joinSeam over a whole list of pieces, in order. */
export function joinPieces(pieces: readonly string[]): {
  text: string
  deduped: number
  joined: number
} {
  let text = ''
  let deduped = 0
  let joined = 0
  for (const p of pieces) {
    if (!p.trim()) continue
    const j = joinSeam(text, p)
    text = j.text
    deduped += j.deduped
    if (j.joined) joined++
  }
  return { text: text.trim(), deduped, joined }
}

/**
 * What a piece is told precedes it: the end of the piece before, from its last sentence start,
 * at most `maxWords` words. Enough to say "this continues a sentence" without inviting the model
 * to copy the earlier text into its answer.
 */
export function seamContext(prev: string, maxWords = 12): string {
  const t = prev.trim()
  if (!t) return ''
  const tail = t.slice(lastSentenceStart(t))
  const ws = words(tail)
  if (ws.length <= maxWords) return tail
  return tail.slice(ws[ws.length - maxWords].start)
}

/**
 * Where the last sentence of `text` starts (after a terminal mark and a space): a text that ends
 * on a full sentence gives that sentence, one cut mid-sentence its unfinished part.
 */
export function lastSentenceStart(text: string): number {
  const t = text.replace(/\s+$/u, '')
  let start = 0
  for (const m of t.matchAll(/[.!?…]["')\]]*\s+/gu)) start = m.index + m[0].length
  return start
}

/**
 * A formatted piece that starts by repeating the text it was told precedes it (the model copied
 * its context into the answer): that copy is removed. Three or more matching words count.
 */
export function stripEcho(output: string, before: string): string {
  const bw = words(before).slice(-SEAM_WINDOW)
  const ow = words(output)
  if (bw.length < 3 || ow.length <= 3) return output
  const cut = (k: number): string => output.slice(ow[k - 1].end).replace(/^[\s,;:.!?…-]+/u, '')
  // The echo copies the end of the context (exactly, or with one word changed in a long run)...
  for (let k = Math.min(bw.length, ow.length - 1); k >= 3; k--)
    if (runMatches(bw, bw.length, ow, k)) return cut(k)
  // ...or stops a word or three short of it (5+ words), as when the context ends on the first
  // word of what the piece itself says next.
  for (let slack = 1; slack <= ECHO_SLACK; slack++)
    for (let k = Math.min(bw.length - slack, ow.length - 1); k >= 5; k--)
      if (runMatches(bw, bw.length - slack, ow, k)) return cut(k)
  return output
}
