import type { Snippet } from '@shared/settings'
import { WB_END, WB_START, escapeRegex } from './util'

export interface SnippetContext {
  now?: Date
  clipboard?: string
}

export interface SnippetResult {
  text: string
  expanded: string[]
}

/**
 * Replace spoken triggers with their stored content. The trigger may be prefixed with
 * "insert"/"paste"/"snippet" and may carry trailing punctuation from the transcriber.
 * Placeholders: {date} {time} {day} {datetime} {clipboard}
 */
export function expandSnippets(
  text: string,
  snippets: readonly Snippet[],
  ctx: SnippetContext = {}
): SnippetResult {
  const expanded: string[] = []
  if (!snippets.length || !text) return { text, expanded }
  let out = text
  const sorted = [...snippets]
    .filter((s) => s.trigger.trim())
    .sort((a, b) => b.trigger.length - a.trigger.length)
  for (const s of sorted) {
    const trig = escapeRegex(s.trigger.trim()).replace(/\s+/g, '\\s+')
    const re = new RegExp(
      `${WB_START}(?:(?:insert|paste|snippet)\\s+)?${trig}${WB_END}[.,!?;:]*`,
      'giu'
    )
    if (!re.test(out)) continue
    re.lastIndex = 0
    const content = fillPlaceholders(s.content, ctx)
    out = out.replace(re, () => {
      expanded.push(s.trigger)
      return content
    })
  }
  return { text: out, expanded }
}

export function fillPlaceholders(content: string, ctx: SnippetContext): string {
  const now = ctx.now ?? new Date()
  return content
    .replace(
      /\{date\}/gi,
      now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    )
    .replace(
      /\{time\}/gi,
      now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    )
    .replace(/\{day\}/gi, now.toLocaleDateString(undefined, { weekday: 'long' }))
    .replace(/\{datetime\}/gi, now.toLocaleString())
    .replace(/\{clipboard\}/gi, ctx.clipboard ?? '')
}
