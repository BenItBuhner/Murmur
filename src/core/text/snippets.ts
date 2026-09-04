import type { Snippet } from '@shared/settings'
import { WB_SNIPPET_PREFIX } from '@shared/constants'

export function expandSnippets(text: string, snippets: Snippet[]): string {
  let result = text
  for (const snippet of snippets) {
    const trigger = `${WB_SNIPPET_PREFIX}${snippet.trigger}`
    if (result.includes(trigger)) {
      result = result.replaceAll(trigger, snippet.expansion)
    }
  }
  return result
}

export function findSnippetByTrigger(
  trigger: string,
  snippets: Snippet[]
): Snippet | undefined {
  const normalized = trigger.startsWith(WB_SNIPPET_PREFIX)
    ? trigger.slice(WB_SNIPPET_PREFIX.length)
    : trigger
  return snippets.find((s) => s.trigger === normalized)
}

export function listSnippetTriggers(snippets: Snippet[]): string[] {
  return snippets.map((s) => `${WB_SNIPPET_PREFIX}${s.trigger}`)
}

export function validateSnippet(snippet: Snippet): string | null {
  if (!snippet.trigger.trim()) return 'Trigger cannot be empty'
  if (!snippet.expansion.trim()) return 'Expansion cannot be empty'
  if (snippet.trigger.includes(' ')) return 'Trigger cannot contain spaces'
  return null
}

export function sortSnippetsByTrigger(snippets: Snippet[]): Snippet[] {
  return [...snippets].sort((a, b) => a.trigger.localeCompare(b.trigger))
}

export function mergeSnippets(base: Snippet[], overrides: Snippet[]): Snippet[] {
  const map = new Map<string, Snippet>()
  for (const s of base) map.set(s.trigger, s)
  for (const s of overrides) map.set(s.trigger, s)
  return sortSnippetsByTrigger([...map.values()])
}

export function snippetToDisplay(snippet: Snippet): { trigger: string; preview: string } {
  const preview =
    snippet.expansion.length > 60
      ? `${snippet.expansion.slice(0, 57)}...`
      : snippet.expansion
  return { trigger: snippet.trigger, preview }
}
