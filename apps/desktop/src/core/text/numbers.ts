import type { NumbersMode } from '@shared/settings'

/**
 * Spelled-out numbers -> digits, deterministically.
 *   "five pm" -> "5 pm"        "five thirty pm" -> "5:30 pm"     "twenty three percent" -> "23%"
 *   "ten dollars" -> "$10"     "two point five" -> "2.5"         "version two point three" -> "version 2.3"
 *   "twenty twenty six" -> "2026"   "three thousand" -> "3,000"    "the twenty first" -> "the 21st"
 *
 * `smart` follows the usual style rule (digits from ten up, and always when a unit makes digits
 * natural); `all` converts every number, which is what code and terminals want. Idiomatic "one"
 * ("one of them", "no one") is never touched, and ambiguous pairs ("seventeen fifty") are left alone.
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
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
  trillion: 1_000_000_000_000
}
const ORDINAL_ONES: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19
}
const ORDINAL_TENS: Record<string, number> = {
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90
}

/** Words that are number words; the repetition stage leaves runs of these alone. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(ONES),
  ...Object.keys(TENS),
  ...Object.keys(SCALES),
  'oh'
])

const MONTHS =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?\s*$/i

/** Units after which digits are the natural style even for small numbers. */
const UNIT_AFTER =
  /^\s*(?:percent|per\s+cent|%|dollars?|bucks|cents?|euros?|pounds?|quid|yen|rupees?|francs?|pesos?|a\.?m\.?|p\.?m\.?|o'?clock|degrees?|km|kilomet(?:er|re)s?|miles?|met(?:er|re)s?|feet|foot|inch(?:es)?|cm|mm|centimet(?:er|re)s?|millimet(?:er|re)s?|kg|kilos?|kilograms?|grams?|lbs?|ounces?|oz|lit(?:er|re)s?|gallons?|ml|hours?|hrs?|minutes?|mins?|seconds?|secs?|ms|milliseconds?|weeks?|months?|years?|days?|gb|mb|kb|tb|gigabytes?|megabytes?|kilobytes?|terabytes?|px|pixels?|x|times|fps|hz|mph|kph|mbps|gbps)(?![\p{L}\p{N}])/iu

/** A category noun before the number: "chapter five", "room 12", "step three". */
const NOUN_BEFORE =
  /\b(?:number|num|chapter|page|pages|step|steps|room|figure|fig|table|line|lines|item|items|option|question|section|part|level|version|v|ver|release|build|episode|season|week|day|grade|floor|gate|platform|track|route|highway|exit|unit|apartment|apt|suite|zone|phase|tier|round|lap|size|sizes|group|team|iteration|sprint|ticket|issue|pr|bug|port|error|code|id|channel|volume|vol|article|paragraph|verse|psalm|scene|column|row|slide|invoice|flight|bus|train|task|point|score|scored|rating|rated|age|aged|ages|turned)\.?\s+$/i

const TIME_BEFORE =
  /\b(?:at|around|about|by|until|till|before|after|from|to|between|since|past|@)\s+$/i
const YEAR_BEFORE =
  /\b(?:in|since|from|until|till|by|before|after|of|year|the|circa|around|about|to|through|born|founded|established|back|early|late|mid|summer|winter|spring|fall|autumn|class|copyright)\s+$/i
const AMPM = /^\s*(a\.?m\.?|p\.?m\.?)(?![\p{L}\p{N}])/iu
const OCLOCK = /^\s*o'?clock(?![\p{L}])/iu
const VERSION_BEFORE =
  /\b(?:version|v|ver|release|python|node|java|php|ruby|ios|android|macos|windows|ubuntu|angular|vue|kotlin|typescript)\.?\s+$/i

/** "one" is idiomatic in far too many places to convert on its own. */
const ONE_IDIOM_AFTER =
  /^\s+(?:of|another|day|time|thing|more|way|hand|else|side|last|final|moment|minute|second|by|on|to|at|in|for|with|or|and|please|too|that|who|which|point|step|bit|little|other)(?![\p{L}\p{N}])/iu
const ONE_IDIOM_BEFORE =
  /\b(?:no|some|any|every|each|which|this|that|the|only|just|number|anyone|someone|everyone|nobody|somebody|everybody|day|one)\s+$/i

interface Tok {
  text: string
  lower: string
  start: number
  end: number
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu

function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0]
    out.push({ text: t, lower: t.toLowerCase(), start: m.index, end: m.index + t.length })
  }
  return out
}

/** Consecutive tokens may only be separated by whitespace or a hyphen to belong to one number. */
function joined(text: string, a: Tok, b: Tok): boolean {
  return /^[\s-]+$/.test(text.slice(a.end, b.start))
}

const isDigits = (s: string): boolean => /^\d+$/.test(s)
const isSmallOnes = (t: Tok | undefined): boolean => !!t && t.lower in ONES && ONES[t.lower] <= 9

export interface ParsedNumber {
  value: number
  /** Index of the first token after the number. */
  next: number
  /** "hundred"/"thousand" produced the value (so thousands grouping applies). */
  scaled: boolean
  /** Scale word to keep as-is after the digits ("2 million"). */
  keepScale?: string
  /** Decimal digits as spoken ("point one four" -> "14"). */
  fraction?: string
  /** Digits spoken one by one ("five five five one two one two"). */
  digitRun?: boolean
  yearLike?: boolean
  /** Ambiguous ("seventeen fifty"): leave every token unchanged. */
  blocked?: boolean
}

/**
 * Parse a cardinal starting at `i`. Returns null when the token is not the start of a number.
 * Grammar: [a] group (hundred [and] group)? (thousand [and] group)* (point digit+ | and a half)?
 */
export function parseCardinal(tokens: Tok[], text: string, i: number): ParsedNumber | null {
  const at = (k: number): Tok | undefined => tokens[k]
  const contiguous = (k: number): boolean =>
    k === i || (k < tokens.length && k > 0 && joined(text, tokens[k - 1], tokens[k]))
  const before = text.slice(0, tokens[i].start)

  // Digits spoken one by one: four or more single digits in a row.
  let k = i
  const digits: number[] = []
  while (k < tokens.length && contiguous(k) && isSmallOnes(at(k))) {
    digits.push(ONES[at(k)!.lower])
    k++
  }
  if (digits.length >= 4)
    return { value: Number(digits.join('')), next: k, scaled: false, digitRun: true }

  let j = i
  let total = 0
  let current = 0
  let sawAny = false
  let scaled = false
  let keepScale: string | undefined
  let lastScale = Infinity
  let hasTens = false
  let hasOnes = false

  const skipAnd = (): void => {
    const a = at(j)
    const n = at(j + 1)
    if (
      a?.lower === 'and' &&
      contiguous(j) &&
      n &&
      contiguous(j + 1) &&
      (n.lower in ONES || n.lower in TENS)
    )
      j++
  }

  if (at(j)?.lower === 'a' && at(j + 1) && contiguous(j + 1) && at(j + 1)!.lower in SCALES) {
    current = 1
    sawAny = true
    j++
  }

  while (j < tokens.length && contiguous(j)) {
    const w = at(j)!.lower
    if (w in ONES || (isDigits(w) && w.length <= 3 && !sawAny)) {
      const v = w in ONES ? ONES[w] : Number(w)
      if (hasOnes) break
      if (hasTens && v >= 10) break
      current += v
      hasOnes = true
      sawAny = true
      j++
      continue
    }
    if (w in TENS) {
      if (hasTens || hasOnes) break
      current += TENS[w]
      hasTens = true
      sawAny = true
      j++
      continue
    }
    if (w === 'hundred') {
      if (!sawAny || current === 0 || current >= 100) break
      current *= 100
      scaled = true
      hasTens = false
      hasOnes = false
      j++
      skipAnd()
      continue
    }
    if (w in SCALES) {
      const s = SCALES[w]
      if (!sawAny || s >= lastScale) break
      if (s >= 1_000_000) {
        keepScale = w
        j++
        break
      }
      total += (current || 1) * s
      current = 0
      lastScale = s
      scaled = true
      hasTens = false
      hasOnes = false
      j++
      skipAnd()
      continue
    }
    break
  }
  if (!sawAny) return null

  let value = total + current
  let yearLike = false
  const nextTok = at(j)
  const pairFollows =
    !scaled &&
    total === 0 &&
    !keepScale &&
    nextTok !== undefined &&
    contiguous(j) &&
    (nextTok.lower in TENS ||
      (nextTok.lower in ONES && ONES[nextTok.lower] >= 10) ||
      nextTok.lower === 'oh' ||
      nextTok.lower === 'hundred')
  if (pairFollows && value >= 10 && value <= 21) {
    // "nineteen ninety nine", "twenty twenty six", "twenty oh five"
    const yr = parseYearTail(tokens, text, j)
    if (yr && (value === 19 || value === 20 || YEAR_BEFORE.test(before))) {
      value = value * 100 + yr.value
      j = yr.next
      yearLike = true
    } else if (yr) {
      // "seventeen fifty": a price, a year or a time; nobody wants "17 50".
      return { value, next: yr.next, scaled: false, blocked: true }
    }
  } else if (pairFollows && nextTok!.lower !== 'hundred' && nextTok!.lower !== 'oh') {
    return { value, next: j + 1, scaled: false, blocked: true }
  }

  let fraction: string | undefined
  if (at(j)?.lower === 'point' && contiguous(j) && at(j + 1) && contiguous(j + 1)) {
    const frac = parseFraction(tokens, text, j + 1)
    if (frac) {
      fraction = frac.digits
      j = frac.next
    }
  } else if (at(j)?.lower === 'and' && contiguous(j) && at(j + 1)?.lower === 'a' && at(j + 2)) {
    const q = at(j + 2)!.lower
    if (q === 'half') {
      fraction = '5'
      j += 3
    } else if (q === 'quarter') {
      fraction = '25'
      j += 3
    }
  }
  if (
    !keepScale &&
    fraction !== undefined &&
    at(j) &&
    contiguous(j) &&
    SCALES[at(j)!.lower] >= 1_000_000
  ) {
    keepScale = at(j)!.lower
    j++
  }
  return { value, next: j, scaled, keepScale, fraction, yearLike }
}

/** The value of a fully spelled-out number ("twenty five", "two point five", "2,500"), or null. */
export function spokenNumberValue(text: string): number | null {
  const trimmed = text.trim()
  if (/^[$€£]?\d[\d,]*(?:\.\d+)?%?$/.test(trimmed)) return Number(trimmed.replace(/[$€£,%]/g, ''))
  const tokens = tokenize(text)
  if (!tokens.length) return null
  const parsed = parseCardinal(tokens, text, 0)
  if (!parsed || parsed.blocked || parsed.next !== tokens.length) return null
  const base =
    parsed.fraction !== undefined ? Number(`${parsed.value}.${parsed.fraction}`) : parsed.value
  return parsed.keepScale ? base * SCALES[parsed.keepScale] : base
}

function parseYearTail(
  tokens: Tok[],
  text: string,
  j: number
): { value: number; next: number } | null {
  const t = tokens[j]
  if (!t) return null
  const w = t.lower
  const n = tokens[j + 1]
  const nJoined = !!n && joined(text, t, n)
  if (w === 'hundred') return { value: 0, next: j + 1 }
  if (w === 'oh' || w === 'o') {
    if (nJoined && isSmallOnes(n)) return { value: ONES[n!.lower], next: j + 2 }
    return null
  }
  if (w in TENS) {
    if (nJoined && isSmallOnes(n)) return { value: TENS[w] + ONES[n!.lower], next: j + 2 }
    return { value: TENS[w], next: j + 1 }
  }
  if (w in ONES && ONES[w] >= 10) return { value: ONES[w], next: j + 1 }
  return null
}

function parseFraction(
  tokens: Tok[],
  text: string,
  j: number
): { digits: string; next: number } | null {
  let digits = ''
  let k = j
  while (k < tokens.length && (k === j || joined(text, tokens[k - 1], tokens[k]))) {
    const t = tokens[k]
    const w = t.lower
    if (isSmallOnes(t)) digits += String(ONES[w])
    else if (w === 'oh' || w === 'o') digits += '0'
    else if (w in TENS) {
      const n = tokens[k + 1]
      if (n && joined(text, t, n) && isSmallOnes(n)) {
        digits += String(TENS[w] + ONES[n.lower])
        k++
      } else digits += String(TENS[w])
    } else if (isDigits(w) && digits === '') digits += w
    else break
    k++
  }
  return digits ? { digits, next: k } : null
}

function parseOrdinal(
  tokens: Tok[],
  text: string,
  i: number
): { value: number; next: number } | null {
  const t = tokens[i]
  if (!t) return null
  if (t.lower in ORDINAL_ONES) return { value: ORDINAL_ONES[t.lower], next: i + 1 }
  if (t.lower in ORDINAL_TENS) return { value: ORDINAL_TENS[t.lower], next: i + 1 }
  if (t.lower in TENS) {
    const n = tokens[i + 1]
    if (n && joined(text, t, n) && n.lower in ORDINAL_ONES && ORDINAL_ONES[n.lower] <= 9)
      return { value: TENS[t.lower] + ORDINAL_ONES[n.lower], next: i + 2 }
  }
  return null
}

export function ordinalSuffix(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

function formatInteger(value: number, grouped: boolean): string {
  if (!grouped || value < 1000) return String(value)
  return value.toLocaleString('en-US')
}

function isSentenceStart(text: string, start: number): boolean {
  const before = text.slice(0, start)
  if (before.trim() === '' || /[.!?\n]\s*$/.test(before)) return true
  const line = before.slice(before.lastIndexOf('\n') + 1)
  return /^\s*(?:[-•*]|\d+\.)\s*$/.test(line)
}

interface Replacement {
  start: number
  end: number
  text: string
}

export function convertNumbers(text: string, mode: NumbersMode): string {
  if (mode === 'off' || !text) return text
  const tokens = tokenize(text)
  const replacements: Replacement[] = []
  const all = mode === 'all'

  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    const before = text.slice(0, t.start)

    // Times: "five thirty pm", "at five fifteen", "five o'clock", "five pm".
    const time = parseTime(tokens, text, i)
    if (time) {
      if (time.text !== null) replacements.push({ start: t.start, end: time.end, text: time.text })
      i = time.next
      continue
    }

    // Versions: "version two point three point one" -> "version 2.3.1".
    if (VERSION_BEFORE.test(before)) {
      const ver = parseVersion(tokens, text, i)
      if (ver) {
        replacements.push({ start: t.start, end: tokens[ver.next - 1].end, text: ver.text })
        i = ver.next
        continue
      }
    }

    const ord = parseOrdinal(tokens, text, i)
    if (ord) {
      const afterText = text.slice(tokens[ord.next - 1].end)
      const theBefore = /\bthe\s+$/i.test(before)
      const convert =
        !isSentenceStart(text, t.start) &&
        (ord.value >= 10 ||
          MONTHS.test(before) ||
          (theBefore && /^\s+of\b/i.test(afterText)) ||
          (theBefore && /^\s*,?\s*\d/.test(afterText)) ||
          (all && theBefore))
      if (convert) {
        replacements.push({
          start: t.start,
          end: tokens[ord.next - 1].end,
          text: `${ord.value}${ordinalSuffix(ord.value)}`
        })
      }
      i = ord.next
      continue
    }

    const num = parseCardinal(tokens, text, i)
    if (!num) {
      i++
      continue
    }
    if (num.blocked) {
      i = num.next
      continue
    }
    const endTok = tokens[num.next - 1]
    const afterText = text.slice(endTok.end)
    const first = t.lower
    const percent = /^\s*(?:percent|per\s+cent)(?![\p{L}])/iu.exec(afterText)
    const money = /^\s*(dollars?|euros?)(?![\p{L}])/iu.exec(afterText)
    const unit = UNIT_AFTER.test(afterText)
    const noun = NOUN_BEFORE.test(before)
    const hasFraction = num.fraction !== undefined
    const value = num.value
    const quantityContext = !!(percent || money || unit || noun)

    if (first === 'one' && !hasFraction && !num.digitRun && !num.scaled && value === 1) {
      // Idiomatic "one" stays, unless a unit or noun makes it a quantity.
      if (!quantityContext || ONE_IDIOM_AFTER.test(afterText) || ONE_IDIOM_BEFORE.test(before)) {
        i = num.next
        continue
      }
    }
    if (first === 'a' && !all && !(percent || money || unit)) {
      // "a hundred people" stays; "a hundred percent" becomes 100%.
      i = num.next
      continue
    }

    const wantsDigits =
      all ||
      hasFraction ||
      num.digitRun ||
      num.yearLike ||
      value >= 10 ||
      quantityContext ||
      num.keepScale !== undefined
    if (!wantsDigits) {
      i = num.next
      continue
    }
    if (
      !all &&
      isSentenceStart(text, t.start) &&
      !(quantityContext || hasFraction || num.digitRun || num.yearLike) &&
      value < 100
    ) {
      // "Twelve people came." keeps its word: sentences do not start with digits.
      i = num.next
      continue
    }

    // "two thousand twenty six" is a year, not "2,026"; "two thousand dollars" is "$2,000".
    const yearish = num.scaled && value >= 1900 && value <= 2099 && !quantityContext && !hasFraction
    const grouped = num.scaled && !num.yearLike && !num.digitRun && !yearish
    const digits = `${formatInteger(value, grouped)}${hasFraction ? `.${num.fraction}` : ''}`
    let end = endTok.end
    let out: string
    if (percent) {
      out = `${digits}%`
      end += percent[0].length
    } else if (money) {
      const symbol = /^e/i.test(money[1]) ? '€' : '$'
      end += money[0].length
      let cents = ''
      if (!num.keepScale && !hasFraction) {
        // "ten dollars and fifty cents" -> "$10.50"
        const m = /^\s+and\s+([\p{L}\p{N}]+(?:[\s-][\p{L}\p{N}]+)?)\s+cents?(?![\p{L}])/iu.exec(
          text.slice(end)
        )
        if (m) {
          const centTokens = tokenize(m[1])
          const parsed = centTokens.length ? parseCardinal(centTokens, m[1], 0) : null
          const centVal =
            parsed && !parsed.blocked ? parsed.value : isDigits(m[1]) ? Number(m[1]) : NaN
          if (!Number.isNaN(centVal) && centVal < 100) {
            cents = `.${String(centVal).padStart(2, '0')}`
            end += m[0].length
          }
        }
      }
      out = `${symbol}${digits}${cents}${num.keepScale ? ` ${num.keepScale}` : ''}`
    } else {
      out = num.keepScale ? `${digits} ${num.keepScale}` : digits
    }
    replacements.push({ start: t.start, end, text: out })
    i = num.next
  }

  if (!replacements.length) return text
  let result = ''
  let cursor = 0
  for (const r of replacements) {
    if (r.start < cursor) continue
    result += text.slice(cursor, r.start) + r.text
    cursor = r.end
  }
  result += text.slice(cursor)
  return fixRanges(result)
}

const SIMPLE_WORDS = Object.keys(ONES)
  .filter((w) => ONES[w] > 0)
  .join('|')
const RANGE_LEFT = new RegExp(`\\b(${SIMPLE_WORDS})(\\s+(?:to|or|through|-|–)\\s+)(\\d)`, 'gi')
const RANGE_RIGHT = new RegExp(`(\\d)(\\s+(?:to|or|through|-|–)\\s+)(${SIMPLE_WORDS})\\b`, 'gi')

/** "five to 10%" -> "5 to 10%": a spelled-out number next to a converted one follows it. */
function fixRanges(text: string): string {
  return text
    .replace(
      RANGE_LEFT,
      (_m, w: string, sep: string, d: string) => `${ONES[w.toLowerCase()]}${sep}${d}`
    )
    .replace(
      RANGE_RIGHT,
      (_m, d: string, sep: string, w: string) => `${d}${sep}${ONES[w.toLowerCase()]}`
    )
}

function hourValue(tok: Tok): number | null {
  if (tok.lower in ONES && ONES[tok.lower] >= 1 && ONES[tok.lower] <= 12) return ONES[tok.lower]
  if (
    isDigits(tok.lower) &&
    tok.lower.length <= 2 &&
    Number(tok.lower) >= 1 &&
    Number(tok.lower) <= 12
  )
    return Number(tok.lower)
  return null
}

function minuteValue(
  tokens: Tok[],
  text: string,
  j: number
): { value: number; next: number } | null {
  const t = tokens[j]
  if (!t) return null
  const n = tokens[j + 1]
  const nJoined = !!n && joined(text, t, n)
  if (t.lower === 'oh' || t.lower === 'o') {
    if (nJoined && isSmallOnes(n)) return { value: ONES[n!.lower], next: j + 2 }
    return null
  }
  if (t.lower in TENS && TENS[t.lower] <= 50) {
    if (nJoined && isSmallOnes(n)) return { value: TENS[t.lower] + ONES[n!.lower], next: j + 2 }
    return { value: TENS[t.lower], next: j + 1 }
  }
  if (t.lower in ONES && ONES[t.lower] >= 10) return { value: ONES[t.lower], next: j + 1 }
  if (isDigits(t.lower) && t.lower.length === 2 && Number(t.lower) < 60)
    return { value: Number(t.lower), next: j + 1 }
  return null
}

interface TimeResult {
  /** null: the tokens look like a time but nothing marks it; leave them unchanged. */
  text: string | null
  end: number
  next: number
}

function parseTime(tokens: Tok[], text: string, i: number): TimeResult | null {
  const t = tokens[i]
  const hour = hourValue(t)
  if (hour === null) return null
  const before = text.slice(0, t.start)
  let next = i + 1
  let minutes: number | null = null
  if (tokens[next] && joined(text, t, tokens[next])) {
    const m = minuteValue(tokens, text, next)
    if (m) {
      minutes = m.value
      next = m.next
    }
  }
  const endTok = tokens[next - 1]
  const after = text.slice(endTok.end)
  const ampm = AMPM.exec(after)
  const oclock = OCLOCK.exec(after)
  if (!ampm && !oclock) {
    if (minutes === null) return null
    // "at five thirty" is a time; "five thirty" alone is ambiguous and stays as spoken.
    if (!TIME_BEFORE.test(before) || isDigits(t.lower)) return { text: null, end: endTok.end, next }
    return { text: `${hour}:${String(minutes).padStart(2, '0')}`, end: endTok.end, next }
  }
  if (isDigits(t.lower) && minutes === null) return null // "5 pm" is already digits
  let out = minutes === null ? String(hour) : `${hour}:${String(minutes).padStart(2, '0')}`
  if (oclock) out += " o'clock"
  else if (ampm) out += ` ${ampm[1].toLowerCase().replace(/\./g, '')}`
  const end = endTok.end + (oclock ?? ampm)![0].length
  while (next < tokens.length && tokens[next].end <= end) next++
  return { text: out, end, next }
}

function parseVersion(
  tokens: Tok[],
  text: string,
  i: number
): { text: string; next: number } | null {
  const parts: string[] = []
  let j = i
  while (j < tokens.length && (j === i || joined(text, tokens[j - 1], tokens[j]))) {
    const t = tokens[j]
    const w = t.lower
    if (parts.length % 2 === 0) {
      if (w in ONES) parts.push(String(ONES[w]))
      else if (w in TENS) {
        const n = tokens[j + 1]
        if (n && joined(text, t, n) && isSmallOnes(n)) {
          parts.push(String(TENS[w] + ONES[n.lower]))
          j++
        } else parts.push(String(TENS[w]))
      } else if (isDigits(w)) parts.push(w)
      else break
    } else if (w === 'point' || w === 'dot') parts.push('.')
    else break
    j++
  }
  if (parts.length % 2 === 0 && parts.length > 0) {
    parts.pop()
    j--
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && !(tokens[i].lower in ONES || tokens[i].lower in TENS)) return null
  return { text: parts.join(''), next: j }
}
