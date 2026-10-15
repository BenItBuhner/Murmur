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

  // 1. The word(s) at the cut heard by both pieces.
  const hw = words(h).slice(-8)
  let tw = words(t).slice(0, 8)
  let deduped = 0
  for (let k = Math.min(hw.length, tw.length); k >= 1; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) same = hw[hw.length - k + i].key === tw[i].key
    // One shared short word is an echo only if it is a function word ("to to", "the the"),
    // which nobody doubles on purpose; "it it" or "no no" may have been said.
    if (same && (k >= 2 || tw[0].key.length >= 4 || CONTINUATION.has(tw[0].key))) {
      deduped = k
      break
    }
  }
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
  } else if (deduped) {
    t = t.slice(tw[deduped - 1].end).replace(/^[\s,;:.!?…-]+/u, '')
    if (!t) return { text: h, deduped, joined: false }
    tw = words(t).slice(0, 8)
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
  // Sentence starts: after a terminal mark and space. A piece that ended on a full sentence
  // gives that sentence; one cut mid-sentence gives the unfinished part.
  const starts = [0, ...[...t.matchAll(/[.!?…]["')\]]*\s+/gu)].map((m) => m.index + m[0].length)]
  const tail = t.slice(starts[starts.length - 1])
  const ws = words(tail)
  if (ws.length <= maxWords) return tail
  return tail.slice(ws[ws.length - maxWords].start)
}

/**
 * A formatted piece that starts by repeating the text it was told precedes it (the model copied
 * its context into the answer): that copy is removed. Three or more matching words count.
 */
export function stripEcho(output: string, before: string): string {
  const bw = words(before)
  const ow = words(output)
  if (bw.length < 3 || ow.length <= 3) return output
  for (let k = Math.min(bw.length, ow.length - 1); k >= 3; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) same = ow[i].key === bw[bw.length - k + i].key
    if (same) return output.slice(ow[k - 1].end).replace(/^[\s,;:.!?…-]+/u, '')
  }
  return output
}
