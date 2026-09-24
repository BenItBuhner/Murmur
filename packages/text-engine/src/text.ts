/** String helpers shared by every stage. Pure functions, unicode-aware. */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Word boundary that works for unicode letters and for tokens starting/ending with symbols. */
export const WB_START = '(?<![\\p{L}\\p{N}_])'
export const WB_END = '(?![\\p{L}\\p{N}_])'

export function wordRegex(phrase: string, flags = 'giu'): RegExp {
  const inner = escapeRegex(phrase.trim()).replace(/\s+/g, '\\s+')
  return new RegExp(`${WB_START}${inner}${WB_END}`, flags)
}

export function countWords(text: string): number {
  const m = text.trim().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)
  return m ? m.length : 0
}

export function capitalizeFirst(s: string): string {
  const idx = s.search(/\p{L}/u)
  if (idx < 0) return s
  return s.slice(0, idx) + s[idx].toUpperCase() + s.slice(idx + 1)
}

export function isCapitalized(word: string): boolean {
  return /^\p{Lu}/u.test(word)
}

export const QUESTION_START =
  /^(?:what|who|whom|whose|when|where|why|how|which|is|are|was|were|do|does|did|can|could|will|would|should|shall|may|might|am|have|has|had|isn't|aren't|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't)\b/i

/** A dictation that is a question: it ends with one or starts like one. */
export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\?\s*$/.test(t)) return true
  const firstSentence = t.split(/(?<=[.!?])\s+/)[0] ?? t
  return (
    QUESTION_START.test(firstSentence) &&
    !/[.!]$/.test(firstSentence) &&
    countWords(firstSentence) >= 3
  )
}

/** Damerau-Levenshtein distance (optimal string alignment) with early cutoff. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const la = a.length
  const lb = b.length
  if (la === 0) return lb
  if (lb === 0) return la
  let prev2: number[] = []
  let prev: number[] = Array.from({ length: lb + 1 }, (_, i) => i)
  for (let i = 1; i <= la; i++) {
    const cur: number[] = [i]
    let rowMin = i
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1)
      }
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[lb]
}

/** Collapse whitespace. Trailing newlines survive (a spoken "new line" at the end is intentional). */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/[ \t]+$/, '')
}

export function fixPunctuationSpacing(text: string): string {
  return (
    text
      .replace(/\s+([,.!?;:%])/g, '$1')
      // A comma between digits is a thousands separator ("25,000"), a colon a time ("5:30").
      .replace(/(?<!\d)([,;:])(?=[\p{L}\p{N}])|([,;:])(?=\p{L})/gu, '$1$2 ')
      .replace(/([.!?])(?=[\p{Lu}])/gu, '$1 ')
      .replace(/,{2,}/g, ',')
      .replace(/(?<!\.)\.{2}(?!\.)/g, '.')
      .replace(/([!?])\1{2,}/g, '$1')
      .replace(/,\s*([.!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/[ \t]{2,}/g, ' ')
  )
}

const ABBREVIATION =
  /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|jr|sr|approx|no|inc|ltd|co|fig|est|dept|p|pp|\p{L})\.$/iu

export function capitalizeSentences(text: string): string {
  let out = capitalizeFirst(text)
  out = out.replace(
    /([.!?]\s+|\n\s*)(\p{Ll})/gu,
    (m: string, sep: string, ch: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset + 1)
      if (sep.startsWith('.') && ABBREVIATION.test(before)) return m
      return sep + ch.toUpperCase()
    }
  )
  // Standalone pronoun "i".
  out = out.replace(/(^|[\s(])i(?=[\s,.!?']|$)/g, '$1I')
  return out
}

/**
 * Consecutive dictations should read naturally when inserted back to back, so a sentence that
 * does not already end with whitespace gets one trailing space.
 */
export function applyTrailing(text: string, trailingSpace: boolean): string {
  if (!text || !trailingSpace) return text
  if (/\s$/.test(text)) return text
  return `${text} `
}

/** Reject obviously broken results (only punctuation / whitespace). */
export function isMeaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}
