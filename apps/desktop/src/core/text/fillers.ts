import { escapeRegex } from './util'

const OPENERS =
  /^(?:so|well|okay|ok|yeah|yes|no|right|anyway|also|and|but|first|now|look|alright|sure|oh|hey|hi|hello|thanks|please)$/i
const GREETING = /\b(?:hey|hi|hello|dear|thanks|thank you|good (?:morning|afternoon|evening)|yo)\b/i

/**
 * Remove standalone filler words. Handles the punctuation Whisper wraps around
 * them ("So, um, I think" -> "So, I think") and re-capitalizes when a filler
 * opened a sentence ("Um, so we left." -> "So we left.").
 */
export function removeFillers(text: string, fillers: readonly string[]): string {
  const list = fillers.map((f) => f.trim()).filter(Boolean)
  if (!list.length || !text) return text
  const alternation = list
    .sort((a, b) => b.length - a.length)
    .map((f) => escapeRegex(f).replace(/\s+/g, '\\s+'))
    .join('|')

  // Group 1: leading separator (start, whitespace, or ", "). Group 2: trailing punctuation. Group 3: trailing space.
  const re = new RegExp(
    `(^|\\s+|,\\s*)(?:${alternation})(?![\\p{L}\\p{N}'’-])([,.!?;:]*)(\\s*)`,
    'giu'
  )
  const CAP = '\u0000'

  let out = text.replace(
    re,
    (_match, lead: string, trail: string, space: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset)
      const sentenceEnding = /[.!?]/.test(trail)
      const atSentenceStart = before.trim() === '' || /[.!?\n]\s*$/.test(before)

      if (atSentenceStart) {
        // Filler opened the sentence: drop it entirely and capitalize what follows.
        if (sentenceEnding) return lead === '' ? '' : lead.replace(/,\s*$/, ' ')
        return (lead === '' || /\s$/.test(lead) ? lead : ' ') + CAP
      }

      if (lead.trim() === ',') {
        // "think, um, that" -> "think that" ; "So, uh, can you" -> "So, can you" ; "plan, um. Next" -> "plan. Next"
        if (sentenceEnding) return trail.replace(/,/g, '') + (space || ' ')
        return isOpenerClause(lastClause(before)) ? ', ' : ' '
      }

      if (sentenceEnding) return trail.replace(/,/g, '') + (space || ' ')
      return space ? ' ' : ''
    }
  )

  out = out.replace(new RegExp(`${CAP}\\s*([\\s\\S]?)`, 'gu'), (_m, ch: string) => ch.toUpperCase())
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
}

/** The current sentence up to `before`, without a trailing comma. */
export function lastClause(before: string): string {
  const parts = before.split(/[.!?\n]/)
  const sentence = parts[parts.length - 1] ?? ''
  return sentence.trim().replace(/,\s*$/, '').trim()
}

/** True when the clause is just an opener ("So") or a short greeting ("Hey Sarah") that keeps its comma. */
export function isOpenerClause(clause: string): boolean {
  return OPENERS.test(clause) || (GREETING.test(clause) && clause.split(/\s+/).length <= 4)
}

export { collapseRepeats } from './repeats'
