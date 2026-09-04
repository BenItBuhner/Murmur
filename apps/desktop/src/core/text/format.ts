import { capitalizeFirst } from './util'

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
  return text
    .replace(/\s+([,.!?;:%])/g, '$1')
    .replace(/([,;:])(?=[\p{L}\p{N}])/gu, '$1 ')
    .replace(/([.!?])(?=[\p{Lu}])/gu, '$1 ')
    .replace(/,{2,}/g, ',')
    .replace(/(?<!\.)\.{2}(?!\.)/g, '.')
    .replace(/([!?])\1{2,}/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/[ \t]{2,}/g, ' ')
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

export interface TrailingOptions {
  trailingSpace: boolean
}

/**
 * Consecutive dictations should read naturally when inserted back to back, so a
 * sentence that does not already end with whitespace gets one trailing space.
 */
export function applyTrailing(text: string, opts: TrailingOptions): string {
  if (!text) return text
  if (!opts.trailingSpace) return text
  if (/\s$/.test(text)) return text
  return `${text} `
}

/** Reject obviously broken results (only punctuation / whitespace). */
export function isMeaningful(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}
