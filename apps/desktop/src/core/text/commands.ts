/**
 * Spoken editing commands, evaluated before any other cleanup:
 *   "new line" / "newline"        -> line break
 *   "new paragraph"               -> blank line
 *   "question mark" / "exclamation point|mark" at a clause end -> punctuation
 *   "quote ... end quote|unquote|close quote"    -> "..." (and "quote unquote X" -> "X")
 *   "scratch that" / "delete that" / "strike that" / "undo that" -> remove the last phrase
 *   "press enter" / "hit enter" / "send it" (only at the very end) -> insert text then press Enter
 */

export interface CommandResult {
  text: string
  pressEnter: boolean
}

const ENTER_RE =
  /(?:^|[\s,.;:])(?:press|hit)\s+enter(?:\s+key)?[.!,\s]*$|(?:^|[\s,.;:])(?:and\s+)?send\s+it[.!,\s]*$/i

export function extractPressEnter(text: string): CommandResult {
  const m = text.match(ENTER_RE)
  if (!m) return { text, pressEnter: false }
  const idx = m.index ?? text.length
  const stripped = text.slice(0, idx).replace(/[,\s]+$/, '')
  return { text: stripped, pressEnter: true }
}

export function applyLineCommands(text: string): string {
  let out = text
  // A comma directly before the command belongs to the pause, so it is consumed; sentence
  // punctuation before the command is left untouched because the pattern never spans it.
  out = out.replace(/(?:^|,\s*|\s+)(?:new\s?paragraph|paragraph\s+break)\b[.,!?;:]*\s*/giu, '\n\n')
  out = out.replace(/(?:^|,\s*|\s+)(?:new\s?line|line\s+break)\b[.,!?;:]*\s*/giu, '\n')
  // Capitalize the first word of each new line.
  out = out.replace(
    /\n([ \t]*)(\p{Ll})/gu,
    (_m, ws: string, ch: string) => `\n${ws}${ch.toUpperCase()}`
  )
  return out
}

export function applyLiteralPunctuation(text: string): string {
  return text
    .replace(/[,.]?\s*\bquestion\s+mark\b[.,!?]*/giu, '?')
    .replace(/[,.]?\s*\bexclamation\s+(?:point|mark)\b[.,!?]*/giu, '!')
    .replace(/([?!])\s*([?!])/g, '$1')
}

const QUOTE_CMD =
  /(?<![\p{L}\p{N}])(?:(?:open|begin|start)\s+quote|(?:end|close)\s+(?:of\s+)?quote|unquote|quote)(?![\p{L}\p{N}])/giu

interface QuoteCmd {
  start: number
  end: number
  kind: 'open' | 'close'
}

/**
 * Spoken quotation marks:
 *   "he said quote I will be late end quote"     -> he said "I will be late"
 *   "she told me, quote, hands off, end quote."  -> she told me, "Hands off".
 *   "the quote unquote expert"                   -> the "expert"
 * Only a "quote" with a matching "end quote" / "unquote" / "close quote" is a command, so
 * "I got a quote from the plumber" keeps its noun. Straight marks: they are right everywhere,
 * code editors included.
 */
export function applySpokenQuotes(text: string): string {
  const cmds: QuoteCmd[] = []
  for (const m of text.matchAll(QUOTE_CMD)) {
    cmds.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: /^(?:end|close|unquote)/i.test(m[0]) ? 'close' : 'open'
    })
  }
  if (cmds.length < 2) return text
  let out = ''
  let pos = 0
  let i = 0
  while (i < cmds.length - 1) {
    const open = cmds[i]
    const close = cmds[i + 1]
    // A stray "end quote", or a "quote" followed by another "quote" (the noun, most likely):
    // leave the word and look at the next pair.
    if (open.kind !== 'open' || close.kind !== 'close') {
      i++
      continue
    }
    const before = text.slice(pos, open.start).replace(/\s+$/, '')
    // The pauses around the commands ("quote, hands off, end quote") are not part of the quote.
    const inner = text
      .slice(open.end, close.start)
      .replace(/^\s*[,:;]?\s*/, '')
      .replace(/\s*[,;:]?\s*$/, '')
    let restStart = close.end
    let quoted: string
    if (!/[\p{L}\p{N}]/u.test(inner)) {
      // "quote unquote expert": the marks go around the word that follows.
      const m = /^[\s,]*([\p{L}\p{N}'’-]+)/u.exec(text.slice(close.end))
      if (!m) {
        i += 2
        continue
      }
      quoted = m[1]
      restStart = close.end + m[0].length
    } else {
      // A quotation that follows a pause or opens a sentence starts with a capital.
      quoted = !before || /[,:.!?\n]$/.test(before) ? capitalizeQuote(inner) : inner
    }
    const gap = before && !/[\s(\[\n]$/.test(before) ? ' ' : ''
    out += `${before}${gap}"${quoted}"`
    // Punctuation spoken right after the command attaches to the closing mark.
    const rest = text.slice(restStart)
    const punct = /^\s*[.,!?;:)\]]/.test(rest)
    pos = punct ? restStart + rest.search(/\S/) : restStart
    i += 2
  }
  return out + text.slice(pos)
}

function capitalizeQuote(s: string): string {
  const i = s.search(/\p{L}/u)
  return i < 0 ? s : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1)
}

const SCRATCH_RE = /(?:^|[,.;:]?\s*)(?:scratch|delete|strike|undo|erase)\s+that\b[.,!?;:]*\s*/giu
const LEAD_IN_WORDS = new Set([
  'actually',
  'no',
  'wait',
  'sorry',
  'um',
  'uh',
  'hmm',
  'oh',
  'ok',
  'okay',
  'never',
  'mind',
  'nevermind',
  'and'
])

/**
 * "Send it tomorrow. Actually, scratch that. Send it today." -> "Send it today."
 * Deletes back to the previous sentence boundary. If the words in the current sentence before
 * the command are only lead-ins ("actually", "no", ...), the previous sentence is deleted too.
 */
export function applyScratchThat(text: string): string {
  let out = text
  let guard = 0
  while (guard++ < 20) {
    SCRATCH_RE.lastIndex = 0
    const m = SCRATCH_RE.exec(out)
    if (!m) break
    const cmdStart = m.index
    const cmdEnd = m.index + m[0].length
    const before = out.slice(0, cmdStart)
    let cut = lastSentenceBoundary(before)
    const partial = before.slice(cut).trim()
    const partialWords = partial
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}']/gu, '').toLowerCase())
      .filter(Boolean)
    if (
      partialWords.length === 0 ||
      (partialWords.length <= 2 && partialWords.every((w) => LEAD_IN_WORDS.has(w)))
    ) {
      cut = lastSentenceBoundary(before.slice(0, cut).replace(/[.!?\s]+$/, ''))
    }
    const head = out.slice(0, cut).replace(/\s+$/, '')
    let tail = out.slice(cmdEnd).replace(/^\s+/, '')
    if (tail) tail = tail[0].toUpperCase() + tail.slice(1)
    out = head ? (tail ? `${head} ${tail}` : head) : tail
  }
  return out
}

function lastSentenceBoundary(s: string): number {
  const m = s.match(/[.!?\n](?=\s|$)(?![\s\S]*[.!?\n](?=\s|$))/u)
  if (!m || m.index === undefined) return 0
  return m.index + 1
}
