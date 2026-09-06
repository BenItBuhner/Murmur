import type { BulletMarker, ListStyle, ListsMode } from '@shared/settings'

/**
 * Deterministic list detection. Three signals, from most to least explicit:
 *   commands   "bullet point milk, bullet point eggs", "number one…, number two…", "step one…"
 *   requests   "make this a numbered list: …", "as bullet points", "here are three things: a, b, c"
 *   speech     "first…, second…, third…" / "1. … 2. …" (only in `auto` mode)
 * Requests that are pure instructions ("put this in a bulleted list") are removed; lead-ins that
 * carry meaning ("Here are the steps:") stay as the line above the list.
 */

export type ListKind = 'bullets' | 'numbers'

export interface ListIntent {
  /** What the speaker asked for, when they asked. */
  requested: ListKind | 'any' | null
  /** An explicit request or command was spoken (as opposed to inferred from ordinals). */
  explicit: boolean
  /** Number of list markers found ("first", "number two", "bullet point"). */
  markers: number
}

export interface ListOptions {
  mode: ListsMode
  style: ListStyle
  marker: BulletMarker
  capitalize: boolean
}

export interface ListResult {
  text: string
  applied: boolean
  kind?: ListKind
  items?: number
  intent: ListIntent
}

const ORD_WORDS: Record<string, number> = {
  first: 1,
  firstly: 1,
  second: 2,
  secondly: 2,
  third: 3,
  thirdly: 3,
  fourth: 4,
  fourthly: 4,
  fifth: 5,
  fifthly: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12
}
const CARD_WORDS: Record<string, number> = {
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
  nineteen: 19,
  twenty: 20
}
const COUNT_WORDS: Record<string, number> = {
  ...CARD_WORDS,
  couple: 2,
  few: 0,
  several: 0,
  some: 0
}

const KIND_WORDS =
  '(?:bullet(?:ed)?(?:\\s+point)?|numbered|ordered|unordered|dash(?:ed)?|to-?do|checklist|check)'
const LIST_NOUN = '(?:list|bullet\\s+points?|bullets|points)'

/** A spoken instruction about formatting, at the very start. */
const LEAD_INSTRUCTION = new RegExp(
  `^(?:(?:okay|ok|so|alright|um|uh|and|now)[,.]?\\s+)*` +
    `(?:(?:can|could|would)\\s+you\\s+(?:please\\s+)?|please\\s+|let's\\s+|i\\s+(?:want|need)\\s+(?:you\\s+)?to\\s+|just\\s+)?` +
    `(?:make|create|put|format|write|turn|give\\s+me|do|type|convert)\\s+` +
    `(?:(?:this|that|these|those|it|them|the\\s+following)\\s+)?` +
    `(?:(?:as|into|in|to)\\s+)?(?:(?:a|an)\\s+)?${KIND_WORDS}?\\s*${LIST_NOUN}` +
    `(?:\\s+(?:of|for|with)\\s+(?:this|that|these|it|them|the\\s+following))?(?:\\s+please)?[:,.]?\\s*`,
  'iu'
)
/** "bullet list:", "numbered list," "in bullet points:" as a bare label at the start. */
const LEAD_LABEL = new RegExp(
  `^(?:(?:okay|ok|so|alright|um|uh)[,.]?\\s+)*(?:(?:as|in)\\s+(?:(?:a|an)\\s+)?)?${KIND_WORDS}?\\s*${LIST_NOUN}(?:\\s+(?:format|form))?[:,.]\\s*`,
  'iu'
)
/** "... as a numbered list", "... in bullet points please" at the very end. */
const TAIL_INSTRUCTION = new RegExp(
  `[,.;]?\\s*(?:(?:and\\s+)?(?:make|put|format|write|turn)\\s+(?:this|that|these|it|them)\\s+)?(?:as|in|into)\\s+(?:(?:a|an)\\s+)?${KIND_WORDS}?\\s*${LIST_NOUN}(?:\\s+(?:format|form))?(?:\\s+please)?[.!]?\\s*$`,
  'iu'
)
/** A request anywhere else ("send it as a bulleted list") still tells us what the speaker wants. */
const ANY_REQUEST = new RegExp(
  `\\b(?:as|in|into)\\s+(?:(?:a|an)\\s+)?${KIND_WORDS}?\\s*${LIST_NOUN}\\b`,
  'iu'
)

const ITEM_NOUNS =
  '(?:list|steps|items|things|points|tasks|options|reasons|ideas|notes|questions|actions|priorities|takeaways|to-?dos|goals|changes|issues|features|requirements|rules|tips|topics|suggestions|updates|requests|bullets)'
/** "here are three things:", "the following:", "a few options," — a lead-in that promises an enumeration. */
const ENUMERATION_LEAD = new RegExp(
  `\\b(?:(?:here\\s+(?:are|is)|these\\s+are|there\\s+are|we\\s+(?:have|need)|i\\s+(?:have|need|want|see))\\s+(?:the\\s+|a\\s+|my\\s+|some\\s+|our\\s+)?(?:(one|two|three|four|five|six|seven|eight|nine|ten|\\d+|couple\\s+of|few|several|some)\\s+)?(?:main\\s+|key\\s+|quick\\s+|small\\s+|big\\s+|other\\s+)?${ITEM_NOUNS}|the\\s+following(?:\\s+${ITEM_NOUNS})?|(one|two|three|four|five|six|seven|eight|nine|ten|\\d+)\\s+(?:main\\s+|key\\s+|quick\\s+)?${ITEM_NOUNS})\\s*([:,;]|\\s+-\\s+)`,
  'iu'
)

const ORDINAL_EXCLUDE =
  '(?!\\s+(?:time|name|place|floor|half|quarter|class|aid|person|day|week|month|year|grade|round|edition|version|draft|attempt|impression|language|priority|choice|option|of\\s+(?!all)|things\\s+first|come|thing\\s+in\\s+the|and\\s+foremost)\\b)'

interface Marker {
  kind: 'bullet' | 'number' | 'ordinal' | 'digit' | 'cardinal' | 'cont'
  value?: number
  /** Start of the marker (including the separator that precedes it). */
  start: number
  /** Start of the item text after the marker. */
  end: number
}

const MARKER_TAIL = "(?![\\p{L}\\p{N}'’-])(?:\\s*[,:.–—-]+)?\\s*"
/** Sentence punctuation before a marker stays with the previous item (lookbehind, not consumed). */
const CLAUSE_LEAD =
  '(^|(?<=[.!?;:\\n])\\s*|,\\s*(?:and\\s+|then\\s+|also\\s+)?|\\s+(?:and|then)\\s+)'

/** Spoken commands: legitimate anywhere, even mid-sentence ("we need bullet point milk"). */
const COMMAND_MARKER_RE = new RegExp(
  '(^|(?<=[.!?;:,\\n])\\s*|\\s+(?:and\\s+|then\\s+)?)' +
    '(?:' +
    '(?<bullet>(?:(?:new|next|another)\\s+)?bullet(?:\\s+point)?|next\\s+(?:item|point|one)|new\\s+(?:item|point))' +
    `|(?<numKind>number|item|step|point|part|no\\.?|#)\\s*(?<numVal>${Object.keys(CARD_WORDS).join('|')}|\\d{1,2})(?:st|nd|rd|th)?` +
    ')' +
    MARKER_TAIL,
  'giu'
)

/** Speech patterns: only at the start of a clause, so "the first time" or "a second" never split. */
const SPEECH_MARKER_RE = new RegExp(
  CLAUSE_LEAD +
    '(?:' +
    `(?<ord>${Object.keys(ORD_WORDS).join('|')})(?:\\s+of\\s+all)?(?:\\s+(?:thing|point|item|step|one|up))?${ORDINAL_EXCLUDE}` +
    '|(?<digit>\\d{1,2})[.)]' +
    `|(?<card>${Object.keys(CARD_WORDS).join('|')})(?=\\s*[,:])` +
    '|(?<cont>(?:and\\s+)?(?:lastly|finally|last\\s+but\\s+not\\s+least|last(?:ly)?))' +
    ')' +
    MARKER_TAIL,
  'giu'
)

function scanWith(re: RegExp, text: string, out: Marker[]): void {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const g = m.groups ?? {}
    const start = m.index
    const end = m.index + m[0].length
    if (end >= text.length && !g.bullet) {
      re.lastIndex = m.index + 1
      continue // a marker with nothing after it is not a marker
    }
    if (g.bullet) out.push({ kind: 'bullet', start, end })
    else if (g.numVal) out.push({ kind: 'number', value: numberOf(g.numVal), start, end })
    else if (g.ord) out.push({ kind: 'ordinal', value: ORD_WORDS[g.ord.toLowerCase()], start, end })
    else if (g.digit) out.push({ kind: 'digit', value: Number(g.digit), start, end })
    else if (g.card)
      out.push({ kind: 'cardinal', value: CARD_WORDS[g.card.toLowerCase()], start, end })
    else if (g.cont) out.push({ kind: 'cont', start, end })
    re.lastIndex = Math.max(end, m.index + 1)
  }
}

function scanMarkers(text: string): Marker[] {
  const out: Marker[] = []
  scanWith(COMMAND_MARKER_RE, text, out)
  scanWith(SPEECH_MARKER_RE, text, out)
  out.sort((a, b) => a.start - b.start)
  // A command marker and a speech marker can overlap ("step one" vs "one,"): keep the earliest.
  const merged: Marker[] = []
  for (const m of out) {
    const prev = merged[merged.length - 1]
    if (prev && m.start < prev.end) continue
    merged.push(m)
  }
  return merged
}

function numberOf(s: string): number {
  const lower = s.toLowerCase()
  return lower in CARD_WORDS ? CARD_WORDS[lower] : Number(lower)
}

function requestedKind(phrase: string): ListKind | 'any' {
  if (/numbered|ordered(?!\s*unordered)|number/i.test(phrase) && !/unordered/i.test(phrase))
    return 'numbers'
  if (/bullet|dash|unordered|check/i.test(phrase)) return 'bullets'
  return 'any'
}

/** What the speaker asked for; usable as a hint even when list formatting is off. */
export function detectListIntent(text: string): ListIntent {
  let requested: ListIntent['requested'] = null
  let explicit = false
  const req =
    LEAD_INSTRUCTION.exec(text) ??
    LEAD_LABEL.exec(text) ??
    TAIL_INSTRUCTION.exec(text) ??
    ANY_REQUEST.exec(text)
  if (req) {
    requested = requestedKind(req[0])
    explicit = true
  }
  const markers = scanMarkers(text).filter((m) => m.kind !== 'cont')
  if (markers.some((m) => m.kind === 'bullet')) {
    explicit = true
    requested = requested ?? 'bullets'
  }
  if (markers.some((m) => m.kind === 'number')) {
    explicit = true
    requested = requested ?? 'numbers'
  }
  return { requested, explicit, markers: markers.length }
}

export function formatLists(text: string, opts: ListOptions): ListResult {
  const intent = detectListIntent(text)
  if (opts.mode === 'off' || !text.trim()) return { text, applied: false, intent }

  // 1. Strip pure formatting instructions and remember what they asked for.
  let body = text
  let requested: ListIntent['requested'] = null
  let explicit = false
  const lead = LEAD_INSTRUCTION.exec(body) ?? LEAD_LABEL.exec(body)
  if (lead) {
    requested = requestedKind(lead[0])
    explicit = true
    body = body.slice(lead[0].length)
  }
  const tail = TAIL_INSTRUCTION.exec(body)
  if (tail && tail.index > 0) {
    requested = requested ?? requestedKind(tail[0])
    explicit = true
    body = body.slice(0, tail.index)
  }
  if (!explicit) {
    const any = ANY_REQUEST.exec(body)
    if (any) {
      requested = requestedKind(any[0])
      explicit = true
    }
  }

  // 2. Markers.
  const markers = scanMarkers(body)
  const fromMarkers = buildFromMarkers(body, markers, { ...opts, explicit, requested })
  if (fromMarkers)
    return { ...render(fromMarkers, opts, requested), intent: { ...intent, explicit } }

  // 3. Lead-in + enumeration ("here are three things: a, b and c").
  const enumerated = buildFromEnumeration(body, { ...opts, explicit, requested })
  if (enumerated) return { ...render(enumerated, opts, requested), intent: { ...intent, explicit } }

  // Nothing to structure, but a stripped instruction should not come back.
  if (explicit && body !== text)
    return { text: body.trim(), applied: false, intent: { ...intent, explicit } }
  return { text, applied: false, intent }
}

interface Built {
  lead: string
  items: string[]
  tail: string
  kind: ListKind
}

interface BuildOptions extends ListOptions {
  explicit: boolean
  requested: ListIntent['requested']
}

function buildFromMarkers(body: string, markers: Marker[], opts: BuildOptions): Built | null {
  if (!markers.length) return null
  const spokenOnly = opts.mode === 'spoken' && !opts.explicit
  // Find where the list starts: a bullet, or a numbered marker with value 1.
  const startIdx = markers.findIndex((m) => {
    if (m.kind === 'bullet') return true
    if (m.kind === 'cont') return false
    if (spokenOnly && m.kind !== 'number') return false
    return m.value === 1
  })
  if (startIdx < 0) return null

  const boundaries: Marker[] = [markers[startIdx]]
  let expect = 2
  let numbered = markers[startIdx].kind !== 'bullet'
  let sawBulletKind = markers[startIdx].kind === 'bullet'
  for (let i = startIdx + 1; i < markers.length; i++) {
    const m = markers[i]
    if (m.kind === 'bullet') {
      boundaries.push(m)
      sawBulletKind = true
      continue
    }
    if (spokenOnly && m.kind !== 'number') continue
    if (m.kind === 'cont') {
      if (boundaries.length >= 2) boundaries.push(m)
      continue
    }
    if (m.value === expect) {
      boundaries.push(m)
      expect++
      numbered = true
    }
    // Out-of-sequence numbers are content ("the second option"), not boundaries.
  }

  const real = boundaries.filter((b) => b.kind !== 'cont')
  const cardinalOnly = real.every((b) => b.kind === 'cardinal')
  const ordinalOnly = real.every((b) => b.kind === 'ordinal')
  const minItems = opts.explicit ? 1 : 2
  if (real.length < minItems) return null
  // A single spoken bullet with an explicit request is still a list of one.
  if (boundaries.length < 2 && !(opts.explicit && sawBulletKind)) return null
  // Ordinal-only lists ("first…, second…") are inferred speech; only in auto mode.
  if (ordinalOnly && opts.mode !== 'auto' && !opts.explicit) return null

  const leadRaw = body.slice(0, boundaries[0].start)
  // Bare "one, … two, …" needs a strong signal: a request, a colon lead-in or three items.
  if (cardinalOnly && !opts.explicit && real.length < 3 && !/:\s*$/.test(leadRaw.trim()))
    return null

  const items: string[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const from = boundaries[i].end
    const to = i + 1 < boundaries.length ? boundaries[i + 1].start : body.length
    items.push(body.slice(from, to))
  }

  let tail = ''
  // Trailing text after a paragraph break belongs after the list.
  const lastBreak = items[items.length - 1].indexOf('\n\n')
  if (lastBreak >= 0) {
    tail = items[items.length - 1].slice(lastBreak).trim()
    items[items.length - 1] = items[items.length - 1].slice(0, lastBreak)
  } else if (items.length >= 3) {
    // Earlier items were single sentences but the last one runs on: the rest is a closing remark.
    const prior = items.slice(0, -1)
    const last = items[items.length - 1]
    const sentenceEnd = /[.!?]\s+(?=\S)/u.exec(last)
    if (sentenceEnd && prior.every((p) => !/[.!?]\s+\S/u.test(p.trim()))) {
      tail = last.slice(sentenceEnd.index + sentenceEnd[0].length).trim()
      items[items.length - 1] = last.slice(0, sentenceEnd.index + 1)
    }
  }
  const cleaned = evenOutPeriods(items.map(cleanItem).filter(Boolean))
  if (cleaned.length < minItems) return null
  const kind: ListKind = numbered && !sawBulletKind ? 'numbers' : 'bullets'
  return { lead: cleanLead(leadRaw), items: cleaned, tail, kind }
}

/** When every item but the last ends a sentence, the last one gets its period too. */
function evenOutPeriods(items: string[]): string[] {
  if (items.length < 2) return items
  const ends = items.map((it) => /[.!?]$/.test(it))
  if (ends.slice(0, -1).every(Boolean) && !ends[ends.length - 1]) {
    return [...items.slice(0, -1), `${items[items.length - 1]}.`]
  }
  return items
}

function buildFromEnumeration(body: string, opts: BuildOptions): Built | null {
  const m = ENUMERATION_LEAD.exec(body)
  let leadEnd = -1
  let expectedCount = 0
  if (m) {
    leadEnd = m.index + m[0].length
    const countWord = (m[1] ?? m[2] ?? '').toLowerCase().replace(/\s+of$/, '')
    if (countWord)
      expectedCount = /^\d+$/.test(countWord) ? Number(countWord) : (COUNT_WORDS[countWord] ?? 0)
  } else if (opts.explicit) {
    // "make this a list: milk, eggs and bread" or "milk, eggs and bread" after a stripped instruction.
    const colon = body.indexOf(':')
    leadEnd = colon >= 0 && colon < body.length / 2 ? colon + 1 : 0
  } else {
    return null
  }
  if (!m && opts.mode !== 'auto' && !opts.explicit) return null
  if (m && opts.mode !== 'auto' && !opts.explicit) return null

  const lead = body.slice(0, leadEnd)
  let rest = body.slice(leadEnd).trim()
  let tail = ''
  const para = rest.indexOf('\n\n')
  if (para >= 0) {
    tail = rest.slice(para).trim()
    rest = rest.slice(0, para).trim()
  }
  if (!rest) return null

  let items = rest
    .split(/\n|;\s*|,\s*(?:and\s+|or\s+)?/u)
    .map((s) => s.trim())
    .filter(Boolean)
  if (items.length >= 2) {
    // "milk, eggs and bread" -> the last comma-item still holds "eggs and bread".
    const last = items[items.length - 1]
    const andSplit = /^(.+?)\s+(?:and|or)\s+(.+)$/iu.exec(last)
    if (
      andSplit &&
      wordCount(andSplit[1]) <= 6 &&
      wordCount(andSplit[2]) <= 12 &&
      (expectedCount === 0 || items.length + 1 === expectedCount)
    )
      items = [...items.slice(0, -1), andSplit[1], andSplit[2]]
  } else if (items.length === 1 && opts.explicit) {
    const parts = items[0].split(/\s+(?:and|or)\s+/iu).map((s) => s.trim())
    if (parts.length >= 2 && parts.every((p) => wordCount(p) <= 8)) items = parts
  }
  if (items.length < 2) return null
  if (expectedCount >= 2 && items.length !== expectedCount) return null
  if (items.some((it) => wordCount(it) > 14)) return null
  // Without an explicit request, only short noun-phrase items become a list.
  if (!opts.explicit && items.some((it) => wordCount(it) > 10)) return null

  const cleaned = items.map(cleanItem).filter(Boolean)
  if (cleaned.length < 2) return null
  const kind: ListKind = opts.requested === 'numbers' ? 'numbers' : 'bullets'
  return { lead: cleanLead(lead), items: cleaned, tail, kind }
}

function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]+/gu) ?? []).length
}

function cleanItem(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[,.;:\-–—\s]+/, '')
  s = s.replace(/^(?:and|then|also|or)\s+/iu, '')
  s = s.replace(/[,;:\s]+$/, '')
  s = s.replace(/[,\s]+(?:and|or|then)$/iu, '')
  s = s.replace(/[,;:\s]+$/, '')
  return s
}

function cleanLead(raw: string): string {
  let s = raw.replace(/[ \t]+/g, ' ').trim()
  if (!s) return ''
  s = s.replace(/[,;:\s]+(?:and|then|so)$/iu, '')
  s = s.replace(/[,;\s\-–—]+$/, '')
  if (!/[.!?:]$/.test(s)) s += ':'
  return s
}

function capitalize(s: string): string {
  const i = s.search(/\p{L}/u)
  return i < 0 ? s : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1)
}

/**
 * Models and other stages write bullets as "*", "•", "–" or "-" and numbers as "1)" or "1.";
 * settle on the configured marker and "1." so lists look the same however they were produced.
 */
export function normalizeListMarkers(text: string, marker: BulletMarker): string {
  return text
    .replace(/(^|\n)[ \t]*[-•*–—·▪◦]\s+(?=\S)/g, `$1${marker} `)
    .replace(/(^|\n)[ \t]*(\d{1,3})[.)]\s+(?=\S)/g, '$1$2. ')
}

function render(
  built: Built,
  opts: ListOptions,
  requested: ListIntent['requested']
): Omit<ListResult, 'intent'> {
  let kind = built.kind
  if (requested === 'bullets' || requested === 'numbers') kind = requested
  if (opts.style === 'bullets') kind = 'bullets'
  else if (opts.style === 'numbers') kind = 'numbers'
  const lines = built.items.map((item, i) => {
    const text = opts.capitalize ? capitalize(item) : item
    return kind === 'numbers' ? `${i + 1}. ${text}` : `${opts.marker} ${text}`
  })
  const parts: string[] = []
  if (built.lead) parts.push(opts.capitalize ? capitalize(built.lead) : built.lead)
  parts.push(lines.join('\n'))
  let text = parts.join('\n')
  if (built.tail) text += `\n\n${opts.capitalize ? capitalize(built.tail) : built.tail}`
  else text += '\n'
  return { text, applied: true, kind, items: built.items.length }
}
