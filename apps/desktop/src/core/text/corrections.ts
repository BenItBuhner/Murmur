/**
 * Deterministic self-correction handling for the most common spoken pattern:
 *   "let's meet on Tuesday, no, Wednesday at 5" -> "let's meet on Wednesday at 5"
 *   "send it to John, I mean, Jane"              -> "send it to Jane"
 *   "at 5, sorry, 6 pm"                          -> "at 6 pm"
 *   "Tuesday at 5, no, Tuesday at 6"             -> "Tuesday at 6"   (anchor alignment)
 *
 * Conservative by design: the marker must be wrapped in commas (which is how Whisper
 * transcribes the pause) and the replacement is bounded by punctuation/conjunctions.
 * The LLM stage handles anything fancier.
 */

const MARKERS = [
  'no wait',
  'wait no',
  'no',
  'i mean',
  'sorry',
  'or rather',
  'rather',
  'correction',
  'make that',
  'scratch that'
]
const STOP_WORDS = new Set([
  'and',
  'but',
  'or',
  'then',
  'so',
  'because',
  'with',
  'at',
  'on',
  'in',
  'to',
  'for',
  'of',
  'by',
  'from'
])

/**
 * A pause right after one of these means the speaker had not said the thing yet ("the flights
 * for, I mean, twenty people"): the marker is hesitation, not a correction, and nothing before
 * it should be replaced.
 */
const UNFINISHED_TAIL = new Set([
  ...STOP_WORDS,
  'the',
  'a',
  'an',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'this',
  'these',
  'those',
  'some',
  'any',
  'is',
  'are',
  'was',
  'were',
  'be',
  'i',
  'we',
  'you',
  'they',
  'he',
  'she',
  'it',
  'that',
  'about',
  'into',
  'onto',
  'like'
])

const markerRe = new RegExp(
  `,\\s*(?:${MARKERS.map((m) => m.replace(/\s+/g, '\\s+')).join('|')})\\s*,\\s*`,
  'giu'
)
const NUMERIC = /^[$€£]?\d[\d,.:]*(?:%|am|pm|k|x)?$/i

interface Tok {
  text: string
  start: number
  end: number
}

export function applySelfCorrections(text: string): string {
  let out = text
  let guard = 0
  while (guard++ < 10) {
    markerRe.lastIndex = 0
    const m = markerRe.exec(out)
    if (!m) break
    const before = out.slice(0, m.index)
    const after = out.slice(m.index + m[0].length)

    const afterAll = leadingTokens(after, 6)
    const beforeAll = trailingTokensInSentence(before, 6)
    const lastBefore = beforeAll[beforeAll.length - 1]
    if (
      !afterAll.length ||
      !beforeAll.length ||
      (lastBefore && UNFINISHED_TAIL.has(lastBefore.text.toLowerCase()))
    ) {
      out = `${before.replace(/\s+$/, '')} ${after}`
      continue
    }

    let beforeSpan: Tok[]
    let replacement: Tok[]

    const anchor = findAnchor(beforeAll, afterAll[0])
    if (anchor >= 0 && beforeAll.length - anchor <= afterAll.length) {
      const n = beforeAll.length - anchor
      beforeSpan = beforeAll.slice(anchor)
      replacement = afterAll.slice(0, n)
    } else if (NUMERIC.test(afterAll[0].text) && lastNumericIndex(beforeAll) >= 0) {
      const idx = lastNumericIndex(beforeAll)
      beforeSpan = [beforeAll[idx]]
      replacement = [afterAll[0]]
    } else {
      const run = boundedRun(afterAll)
      const n = Math.min(run.length, beforeAll.length)
      beforeSpan = beforeAll.slice(beforeAll.length - n)
      replacement = run.slice(0, n)
    }

    const head = before.slice(0, beforeSpan[0].start)
    const tail = after.slice(replacement[replacement.length - 1].end)
    let replacementText = after.slice(replacement[0].start, replacement[replacement.length - 1].end)
    if (/^\s*$/.test(head) || /[.!?]\s*$/.test(head)) replacementText = capitalize(replacementText)
    out = `${head}${replacementText}${tail}`
  }
  return out
}

function leadingTokens(s: string, max: number): Tok[] {
  const re = /[\p{L}\p{N}'’$€£%#@:-]+|[.,;!?\n]/gu
  const out: Tok[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) && out.length < max) {
    const t = m[0]
    if (/^[.,;!?\n]$/.test(t)) break
    out.push({ text: t, start: m.index, end: m.index + t.length })
  }
  return out
}

function trailingTokensInSentence(s: string, max: number): Tok[] {
  const boundary = s.search(/[.!?\n](?=[^.!?\n]*$)/u)
  const startAt = boundary >= 0 ? boundary + 1 : 0
  const re = /[\p{L}\p{N}'’$€£%#@:-]+/gu
  const all: Tok[] = []
  let m: RegExpExecArray | null
  const region = s.slice(startAt)
  while ((m = re.exec(region)))
    all.push({ text: m[0], start: startAt + m.index, end: startAt + m.index + m[0].length })
  return all.slice(Math.max(0, all.length - max))
}

function findAnchor(before: Tok[], first: Tok): number {
  const target = first.text.toLowerCase()
  if (STOP_WORDS.has(target)) return -1
  for (let i = before.length - 1; i >= Math.max(0, before.length - 4); i--) {
    if (before[i].text.toLowerCase() === target) return i
  }
  return -1
}

function lastNumericIndex(before: Tok[]): number {
  for (let i = before.length - 1; i >= Math.max(0, before.length - 3); i--) {
    if (NUMERIC.test(before[i].text)) return i
  }
  return -1
}

/** First run of words (max 3) that stops at a conjunction/preposition after the first word. */
function boundedRun(tokens: Tok[]): Tok[] {
  const out: Tok[] = []
  for (const t of tokens) {
    if (out.length > 0 && STOP_WORDS.has(t.text.toLowerCase())) break
    out.push(t)
    if (out.length === 3) break
  }
  return out
}

function capitalize(s: string): string {
  const i = s.search(/\p{L}/u)
  return i < 0 ? s : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1)
}
