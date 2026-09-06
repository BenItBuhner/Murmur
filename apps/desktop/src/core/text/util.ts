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
