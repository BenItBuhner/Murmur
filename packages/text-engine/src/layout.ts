import { countWords } from './text'
import type { AppCategory, ChatMessage, Complete } from './types'

/**
 * Layout for long dictations: paragraphs and lists.
 *
 * The formatting prompt never adds a paragraph the speaker did not dictate, which is right for a
 * chat message and wrong for ten minutes of talking into a document: it comes out as one wall of
 * text. Long dictations are also formatted in pieces, so no single call sees that "first" and
 * "third" belong to one enumeration.
 *
 * This pass runs once on the finished text. The model is shown the sentences numbered and answers
 * only with where paragraphs start and which sentences are list items; the text itself is laid out
 * here, so no word can be changed, dropped or invented. The only words ever removed are the spoken
 * cues an item starts with ("first,", "number two,", "and finally,"), which the list marker replaces.
 */

/** Below this many words a dictation is short enough to read without paragraphs. */
export const LAYOUT_MIN_WORDS = 150
/** Sentences shown to the model at most; past that the text is left as it is. */
export const LAYOUT_MAX_SENTENCES = 600

/** Destinations where paragraphs and lists help: not chat, code or a terminal. */
export function wantsLayout(text: string, category: AppCategory): boolean {
  if (category === 'chat' || category === 'code' || category === 'terminal') return false
  return countWords(text) >= LAYOUT_MIN_WORDS
}

export interface LayoutUnit {
  text: string
  /** A line break the text already had before this sentence (dictated, or a list the model made). */
  hardBreak: '' | '\n' | '\n\n'
  /** The sentence is already on a list line; its layout is kept. */
  listLine: boolean
}

const LIST_LINE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+\S/u

/** The text as sentences, with the line breaks it already had. */
export function splitUnits(text: string): LayoutUnit[] {
  const units: LayoutUnit[] = []
  const blocks = text.trim().split(/(\n[^\S\n]*\n\s*|\n)/u)
  let pending: LayoutUnit['hardBreak'] = ''
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]
    if (b % 2 === 1) {
      pending = /\n[^\S\n]*\n/u.test(block) ? '\n\n' : pending === '\n\n' ? '\n\n' : '\n'
      continue
    }
    if (!block.trim()) continue
    const listLine = LIST_LINE.test(block)
    const sentences = listLine
      ? [block.trim()]
      : block.trim().split(/(?<=[.!?…]["')\]]*)\s+(?=\S)/u)
    for (const s of sentences) {
      units.push({ text: s, hardBreak: units.length ? pending : '', listLine })
      pending = ''
    }
  }
  return units
}

export const LAYOUT_SYSTEM_PROMPT = [
  'You lay out long voice dictations. You are given the sentences of one dictation, numbered. Do not rewrite anything: reply only with where paragraphs start and which sentences are list items, as JSON.',
  '',
  'Paragraphs: start a new paragraph where the speaker moves to a new topic or a new step, typically every 3 to 8 sentences. Never give each sentence its own paragraph.',
  'Lists: only where the speaker clearly enumerates items ("first..., second..., third...", "number one...", "three things: ... and ..."). Each item starts at one sentence; an item may run over several sentences until the next item. Use "ordered": true when the speaker counted or the order matters. A sentence that introduces the list ("There are three things:") is not an item.',
  '',
  'Reply with exactly this JSON and nothing else: {"paragraphs":[sentence numbers that start a new paragraph],"lists":[{"items":[sentence numbers that start each item],"end":last sentence number of the last item,"ordered":true or false}]}. Use empty arrays when nothing applies.'
].join('\n')

export function buildLayoutMessages(units: readonly LayoutUnit[]): ChatMessage[] {
  const lines = units.map((u, i) => `[${i + 1}] ${u.text.replace(/\s+/g, ' ')}`)
  return [
    { role: 'system', content: LAYOUT_SYSTEM_PROMPT },
    { role: 'user', content: `Sentences:\n${lines.join('\n')}` }
  ]
}

export interface LayoutList {
  /** Indices (0-based) of the sentences that start each item, ascending. */
  items: number[]
  /** Index of the last sentence of the last item. */
  end: number
  ordered: boolean
}

export interface LayoutPlan {
  /** Indices (0-based) of sentences that start a paragraph. */
  paragraphs: number[]
  lists: LayoutList[]
}

const ints = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []

/**
 * The model's answer as a plan over `n` sentences, or null when it is not one. Numbers in the
 * answer are 1-based; anything out of range, overlapping or out of order is dropped.
 */
export function parseLayout(answer: string, n: number): LayoutPlan | null {
  const m = /\{[\s\S]*\}/.exec(answer.replace(/<think>[\s\S]*?<\/think>/gi, ''))
  if (!m) return null
  let raw: { paragraphs?: unknown; lists?: unknown }
  try {
    raw = JSON.parse(m[0]) as typeof raw
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const inRange = (x: number): boolean => x >= 1 && x <= n
  const paragraphs = [...new Set(ints(raw.paragraphs).filter(inRange))]
    .map((x) => x - 1)
    .filter((x) => x > 0)
    .sort((a, b) => a - b)
  const lists: LayoutList[] = []
  let after = -1
  for (const l of Array.isArray(raw.lists) ? raw.lists : []) {
    if (!l || typeof l !== 'object') continue
    const rec = l as { items?: unknown; end?: unknown; ordered?: unknown }
    const items = [...new Set(ints(rec.items).filter(inRange))]
      .map((x) => x - 1)
      .sort((a, b) => a - b)
    if (items.length < 2 || items[0] <= after) continue
    const last = items[items.length - 1]
    const end =
      Number.isInteger(rec.end) && inRange(rec.end as number) && (rec.end as number) - 1 >= last
        ? (rec.end as number) - 1
        : last
    lists.push({ items, end, ordered: rec.ordered === true })
    after = end
  }
  return { paragraphs, lists }
}

const NUMBER_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2}'
/** The spoken cue an item opens with, which its list marker replaces. */
const ITEM_CUE = new RegExp(
  `^(?:and\\s+|also\\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:ly)?|finally|lastly|number\\s+(?:${NUMBER_WORD})|item\\s+(?:${NUMBER_WORD}))\\b(?:\\s+(?:of\\s+all|off))?[,:;.]?\\s+`,
  'iu'
)

/** An item's first sentence without its spoken cue, capitalized. */
export function itemText(sentence: string): string {
  const stripped = sentence.replace(ITEM_CUE, '')
  const text = countWords(stripped) >= 2 ? stripped : sentence
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The sentences laid out by the plan. Existing line breaks and list lines are kept. */
export function applyLayout(units: readonly LayoutUnit[], plan: LayoutPlan): string {
  const paragraphStarts = new Set(plan.paragraphs)
  // A plan that breaks after nearly every sentence is noise, not layout.
  if (paragraphStarts.size > units.length / 2) paragraphStarts.clear()
  const itemAt = new Map<number, { k: number; ordered: boolean }>()
  const listOf: Array<LayoutList | undefined> = []
  for (const l of plan.lists) {
    // A list over sentences that already have line layout of their own is left alone.
    if (units.slice(l.items[0], l.end + 1).some((u) => u.listLine)) continue
    l.items.forEach((i, k) => itemAt.set(i, { k, ordered: l.ordered }))
    for (let i = l.items[0]; i <= l.end; i++) listOf[i] = l
  }
  let out = ''
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    const item = itemAt.get(i)
    let sep = ' '
    if (i === 0) sep = ''
    else if (u.hardBreak) sep = u.hardBreak
    else if (item) sep = item.k === 0 && !listOf[i - 1] ? '\n\n' : '\n'
    else if (listOf[i - 1] && !listOf[i]) sep = '\n\n'
    else if (paragraphStarts.has(i)) sep = '\n\n'
    const text = item ? `${item.ordered ? `${item.k + 1}.` : '-'} ${itemText(u.text)}` : u.text
    out += sep + text
  }
  return out
}

export interface LayoutResult {
  text: string
  /** `used`: the layout changed the text; `skipped`: nothing to do or not wanted; `failed`: the model or its answer let us down. */
  outcome: 'used' | 'skipped' | 'failed'
  detail?: string
  llmMs: number
}

/**
 * Paragraphs and lists for a long dictation. Never throws: on any failure the text comes back
 * as it was.
 */
export async function layoutText(
  text: string,
  category: AppCategory,
  complete: Complete | null
): Promise<LayoutResult> {
  if (!complete) return { text, outcome: 'skipped', detail: 'no model', llmMs: 0 }
  if (!wantsLayout(text, category))
    return { text, outcome: 'skipped', detail: 'short or chat/code/terminal', llmMs: 0 }
  const units = splitUnits(text)
  if (units.length < 4 || units.length > LAYOUT_MAX_SENTENCES)
    return { text, outcome: 'skipped', detail: `${units.length} sentences`, llmMs: 0 }
  const started = Date.now()
  try {
    const res = await complete(buildLayoutMessages(units), {
      maxTokens: Math.min(4096, 1024 + units.length * 6),
      temperature: 0
    })
    const llmMs = Date.now() - started
    const plan = parseLayout(res.text, units.length)
    if (!plan) return { text, outcome: 'failed', detail: 'answer was not a layout', llmMs }
    const laid = applyLayout(units, plan)
    return laid === text
      ? { text, outcome: 'skipped', detail: 'nothing to lay out', llmMs }
      : { text: laid, outcome: 'used', llmMs }
  } catch (err) {
    return {
      text,
      outcome: 'failed',
      detail: err instanceof Error ? err.message : String(err),
      llmMs: Date.now() - started
    }
  }
}
