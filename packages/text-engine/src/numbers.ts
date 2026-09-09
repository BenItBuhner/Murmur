/**
 * The number invariant. Formatting is the model's job; this module only answers one question:
 * do two texts contain the same numbers, in the same order?
 *
 * `digitSignature(text)` reads every number in a text (spoken or written) and returns the digits
 * of all of them concatenated, in order: "one million two hundred thousand dollars" and
 * "$1,200,000" are both "1200000"; "five five five one two one two" and "555-1212" are both
 * "5551212"; "version two point oh point one" and "version 2.0.1" are both "201"; "five thousand
 * five thousand" is "50005000" and a de-duplicated "5,000" is not. The model may write a number
 * any way it likes; it may never change, drop, merge, invent or de-duplicate one.
 *
 * Ordinals ("third", "3rd") are left out on both sides: the model may turn "first..., second..."
 * into list markers, and list markers are stripped before reading.
 */

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
}
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}
/** Scale words that follow a spoken number. */
const SPOKEN_SCALES: Record<string, number> = {
  thousand: 1e3,
  grand: 1e3,
  k: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12
}
/** Scale words and suffixes that follow a written number ("1.5 million", "300k", "2bn"). */
const WRITTEN_SCALES: Record<string, number> = {
  ...SPOKEN_SCALES,
  m: 1e6,
  bn: 1e9
}
/** Scale words that stand for a number on their own ("hundred thousand", "a million"). */
const STANDALONE_SCALES = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion'])
const ORDINALS = new Set([
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'thirtieth',
  'fortieth',
  'fiftieth',
  'sixtieth',
  'seventieth',
  'eightieth',
  'ninetieth',
  'hundredth',
  'thousandth',
  'millionth'
])

const MONTHS = new Set([
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec'
])

/** Words that are (or can be part of) a spoken number. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(ONES),
  ...Object.keys(TENS),
  ...STANDALONE_SCALES,
  'point',
  'oh',
  'half',
  'quarter',
  'double',
  'triple',
  ...ORDINALS
])

export const isNumberWord = (w: string): boolean => NUMBER_WORDS.has(w.toLowerCase())

interface Tok {
  text: string
  lower: string
  /** Whitespace (or the start of the text) separated this token from the previous one. */
  spaced: boolean
}

const TOKEN_RE = /\d+(?:[.,:]\d+)*|\p{L}+(?:['’]\p{L}+)?|[^\s\p{L}\p{N}]/gu
const LIST_MARKER = /^[ \t]*(?:\d{1,3}[.)]|[-*•–—])[ \t]+/gmu

function tokenize(text: string, stripMarkers: boolean): Tok[] {
  const src = stripMarkers ? text.replace(LIST_MARKER, '') : text
  const out: Tok[] = []
  let last = 0
  for (const m of src.matchAll(TOKEN_RE)) {
    const between = src.slice(last, m.index)
    out.push({
      text: m[0],
      lower: m[0].toLowerCase(),
      spaced: m.index === 0 || /\s/.test(between)
    })
    last = m.index + m[0].length
  }
  return out
}

const isOnes = (t: Tok | undefined): boolean => !!t && t.lower in ONES
const isTens = (t: Tok | undefined): boolean => !!t && t.lower in TENS
const isDigits = (t: Tok | undefined): boolean => !!t && /^\d/.test(t.text)
const isOh = (t: Tok | undefined): boolean => !!t && (t.lower === 'oh' || t.lower === 'o')
const isSpokenScale = (t: Tok | undefined): boolean => !!t && t.lower in SPOKEN_SCALES
const isDigitLike = (t: Tok | undefined): boolean =>
  isOnes(t) || isTens(t) || isOh(t) || isDigits(t)

/** Integer-safe rendering: no exponent, no fraction noise. */
function digitsOf(value: number): string {
  if (!Number.isFinite(value)) return ''
  const rounded = Math.round(Math.abs(value))
  if (rounded >= 1e21) return ''
  return String(rounded)
}

/**
 * Digits of a written number token: separators removed ("1,200,000" -> "1200000", "5:30" ->
 * "530", "2.0.1" -> "201"); a plain integer or decimal followed by a scale word or suffix
 * ("1.5 million", "300k") is multiplied out.
 */
function readWritten(tokens: Tok[], i: number): { digits: string; next: number } {
  const t = tokens[i]
  const next = tokens[i + 1]
  // "3rd", "21st": an ordinal, left out of the signature.
  if (next && !next.spaced && /^(?:st|nd|rd|th)$/i.test(next.text) && /^\d+$/.test(t.text))
    return { digits: '', next: i + 2 }
  // "March 3": a day of the month, the written form of the ordinal "March third".
  const prev = tokens[i - 1]
  if (prev && MONTHS.has(prev.lower) && /^\d{1,2}$/.test(t.text) && Number(t.text) <= 31)
    return { digits: '', next: i + 1 }
  if (next && (/^\d+(?:\.\d+)?$/.test(t.text) || /^\d{1,3}(?:,\d{3})+$/.test(t.text))) {
    const scale = WRITTEN_SCALES[next.lower]
    // Single letters only count when glued to the digits ("300k", "2m"); "5 m" is five metres.
    const ok = scale !== undefined && (next.lower.length > 2 || next.lower === 'k' || !next.spaced)
    if (ok) {
      const plain = Number(t.text.replace(/,/g, ''))
      return { digits: digitsOf(plain * scale), next: i + 2 }
    }
  }
  return { digits: t.text.replace(/\D/g, ''), next: i + 1 }
}

/**
 * Read one or more spoken numbers starting at `i`. Returns the digits of each number found (a
 * run of single digits is several numbers, as is "twenty twenty four") and the index after them.
 */
function readSpoken(tokens: Tok[], i: number): { numbers: string[]; next: number } {
  const numbers: string[] = []
  let total = 0
  let current = 0
  let fraction: string | null = null
  let hasOnes = false
  let hasTens = false
  let sawAny = false
  let afterScale = false
  let lastScale = Infinity

  const reset = (): void => {
    total = 0
    current = 0
    fraction = null
    hasOnes = false
    hasTens = false
    sawAny = false
    afterScale = false
    lastScale = Infinity
  }
  const flush = (): void => {
    if (!sawAny) return
    const whole = digitsOf(total + current)
    numbers.push(fraction !== null ? `${whole}${fraction}` : whole)
    reset()
  }
  const at = (k: number): Tok | undefined => tokens[k]

  let j = i
  while (j < tokens.length) {
    const t = at(j)!
    const w = t.lower
    const n = at(j + 1)

    // A hyphen or comma between the parts of a number ("twenty-five", "five, five, five").
    if (/^[-,]$/.test(t.text)) {
      if (sawAny && (isDigitLike(n) || n?.lower === 'hundred' || isSpokenScale(n))) {
        j++
        continue
      }
      break
    }
    // Otherwise the parts of a spoken number are separated by whitespace (or a hyphen just consumed).
    if (j > i && !t.spaced && !/^[-,]$/.test(at(j - 1)?.text ?? '')) break

    if (w === 'a' && !sawAny && (n?.lower === 'hundred' || isSpokenScale(n))) {
      j++
      continue
    }
    if ((w === 'double' || w === 'triple') && (isOh(n) || (isOnes(n) && ONES[n!.lower] <= 9))) {
      flush()
      const d = isOh(n) ? '0' : String(ONES[n!.lower])
      for (let k = 0; k < (w === 'double' ? 2 : 3); k++) numbers.push(d)
      j += 2
      continue
    }
    if (w === 'and' && sawAny) {
      if (afterScale && (isOnes(n) || isTens(n))) {
        j++
        continue
      }
      const q = at(j + 2)?.lower
      if (n?.lower === 'a' && (q === 'half' || q === 'quarter') && fraction === null) {
        fraction = q === 'half' ? '5' : '25'
        j += 3
        continue
      }
      break
    }
    if (isOh(t)) {
      if (!sawAny) break
      if (fraction !== null) {
        fraction += '0'
      } else {
        // "four oh seven": a zero, only when another digit follows.
        if (!isDigitLike(n)) break
        flush()
        numbers.push('0')
      }
      j++
      continue
    }
    if (isOnes(t) || isTens(t)) {
      const v = isOnes(t) ? ONES[w] : TENS[w]
      if (fraction !== null) {
        if (isTens(t) && isOnes(n) && ONES[n!.lower] <= 9) {
          fraction += String(v + ONES[n!.lower])
          j += 2
        } else {
          fraction += String(v)
          j++
        }
        continue
      }
      if (isOnes(t)) {
        // A second ones word in the same group is a new number: digit runs, years, "twenty twenty".
        if (hasOnes || (hasTens && v >= 10)) flush()
        current += v
        hasOnes = true
      } else {
        if (hasTens || hasOnes) flush()
        current += v
        hasTens = true
      }
      sawAny = true
      afterScale = false
      j++
      continue
    }
    if (isDigits(t)) {
      // Written digits end the spoken number and start their own.
      flush()
      const r = readWritten(tokens, j)
      if (r.digits) numbers.push(r.digits)
      j = r.next
      continue
    }
    if (w === 'hundred') {
      if (!sawAny) current = 1
      if (current >= 100 && (hasOnes || hasTens)) {
        // "one hundred one hundred": the earlier hundreds are their own number.
        const tail = current % 100
        numbers.push(digitsOf(total + current - tail))
        total = 0
        current = tail || 1
      }
      current = (current || 1) * 100
      hasOnes = false
      hasTens = false
      sawAny = true
      afterScale = true
      j++
      continue
    }
    if (isSpokenScale(t)) {
      // "k" and "grand" only count right after a spoken number; "hundred thousand" implies one.
      if (!sawAny && !STANDALONE_SCALES.has(w)) break
      const s = SPOKEN_SCALES[w]
      if (!sawAny) current = 1
      if (s >= lastScale) {
        // "five thousand five thousand": what came before this scale is finished.
        if (total) numbers.push(digitsOf(total))
        total = 0
      }
      const head = fraction !== null ? current + Number(`0.${fraction}`) : current || 1
      fraction = null
      total += head * s
      current = 0
      lastScale = s
      hasOnes = false
      hasTens = false
      sawAny = true
      afterScale = true
      j++
      continue
    }
    if ((w === 'point' || w === 'dot') && sawAny && isDigitLike(n)) {
      if (fraction !== null) {
        // "two point oh point one": a version, one number per part.
        flush()
        j++
        continue
      }
      fraction = ''
      j++
      continue
    }
    break
  }
  flush()
  return { numbers, next: j }
}

/** Does a spoken number start at this token? */
function leadsNumber(t: Tok, n: Tok | undefined): boolean {
  if (isOnes(t) || isTens(t)) return true
  if (isOh(t)) return false
  if (STANDALONE_SCALES.has(t.lower)) return true
  if (t.lower === 'a') return !!n && (n.lower === 'hundred' || isSpokenScale(n))
  if (t.lower === 'double' || t.lower === 'triple')
    return isOh(n) || (isOnes(n) && ONES[n!.lower] <= 9)
  return false
}

/**
 * Every number in `text`, spoken or written, as digits in order of appearance. `stripMarkers`
 * ignores list numbering at the start of lines ("1." "2.").
 */
export function numberList(text: string, stripMarkers = true): string[] {
  const tokens = tokenize(text, stripMarkers)
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (isDigits(t)) {
      const r = readWritten(tokens, i)
      if (r.digits) out.push(r.digits)
      i = r.next
      continue
    }
    if (leadsNumber(t, tokens[i + 1])) {
      const r = readSpoken(tokens, i)
      if (r.next > i) {
        out.push(...r.numbers)
        i = r.next
        continue
      }
    }
    i++
  }
  return out
}

/** All digits of all numbers in the text, in order (see the module comment). */
export function digitSignature(text: string, stripMarkers = true): string {
  return numberList(text, stripMarkers).join('')
}

/**
 * Words plus numbers, where a spoken number of any length counts once: "one million two hundred
 * thousand dollars" is two units, exactly like "$1,200,000". Used to compare lengths fairly.
 */
export function countUnits(text: string): number {
  const tokens = tokenize(text, true)
  let count = 0
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (isDigits(t)) {
      count++
      i = readWritten(tokens, i).next
      continue
    }
    if (/^\p{L}/u.test(t.text)) {
      if (leadsNumber(t, tokens[i + 1])) {
        const r = readSpoken(tokens, i)
        if (r.next > i) {
          count += Math.max(1, r.numbers.length)
          i = r.next
          continue
        }
      }
      count++
    }
    i++
  }
  return count
}
