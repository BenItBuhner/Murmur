import {
  applyLineCommands,
  applyLiteralPunctuation,
  applyScratchThat,
  applySpokenQuotes,
  extractPressEnter
} from './commands'
import { applyDictionary } from './dictionary'
import { removeFillers } from './fillers'
import { expandSnippets, type Snippet, type SnippetContext } from './snippets'
import {
  applyTrailing,
  capitalizeSentences,
  fixPunctuationSpacing,
  isMeaningful,
  normalizeWhitespace
} from './text'
import type { AppCategory, DictionaryTerm } from './types'

/**
 * The deterministic stages. There are three moments for rules around the model:
 *
 *   prepare   before the model: the structural commands that are exact and have side effects
 *             ("press enter"), or that are pure layout ("new line", "question mark");
 *   basic     instead of the model: the rule-based fallback when there is no model, the model
 *             failed, or the user turned smart formatting off;
 *   finish    after either: dictionary spellings, spacing, destination finishing, trailing space.
 *
 * Snippets are expanded by the client after finishing, because their content may depend on the
 * device (clipboard, local time).
 */

export interface PreparedTranscript {
  text: string
  pressEnter: boolean
  stages: string[]
}

export function prepareTranscript(raw: string): PreparedTranscript {
  const stages: string[] = []
  let text = normalizeWhitespace(raw)
  const enter = extractPressEnter(text)
  if (enter.pressEnter) {
    stages.push('press-enter')
    text = enter.text
  }
  const step = (name: string, fn: (s: string) => string): void => {
    const next = fn(text)
    if (next !== text) stages.push(name)
    text = next
  }
  step('line-commands', applyLineCommands)
  step('literal-punctuation', applyLiteralPunctuation)
  return { text: normalizeWhitespace(text), pressEnter: enter.pressEnter, stages }
}

export interface BasicCleanupOptions {
  dictionary: readonly DictionaryTerm[]
}

/** Rule-based tidying of a prepared transcript: what "light" formatting and every fallback insert. */
export function basicCleanup(
  prepared: string,
  opts: BasicCleanupOptions
): { text: string; stages: string[] } {
  const stages: string[] = []
  let text = prepared
  const step = (name: string, fn: (s: string) => string): void => {
    const next = fn(text)
    if (next !== text) stages.push(name)
    text = next
  }
  step('scratch-that', applyScratchThat)
  step('quotes', applySpokenQuotes)
  step('fillers', (s) => removeFillers(s))
  step('dictionary', (s) => applyDictionary(s, opts.dictionary))
  step('punctuation', fixPunctuationSpacing)
  step('capitalize', capitalizeSentences)
  return { text: normalizeWhitespace(text), stages }
}

export interface FinishOptions {
  category: AppCategory
  dictionary: readonly DictionaryTerm[]
  trailingSpace: boolean
  snippets?: readonly Snippet[]
  snippetContext?: SnippetContext
}

export interface Finished {
  text: string
  empty: boolean
  stages: string[]
  snippetsExpanded: string[]
}

/** Belt and braces after the model (or the fallback): the parts that must be exact. */
export function finish(text: string, opts: FinishOptions): Finished {
  const stages: string[] = []
  let out = normalizeWhitespace(text)
  const dict = applyDictionary(out, opts.dictionary)
  if (dict !== out) stages.push('dictionary')
  out = fixPunctuationSpacing(dict)
  if (opts.category === 'terminal') {
    // A command stays on one line and never ends in prose punctuation.
    const one = out
      .replace(/\s*\n+\s*/g, ' ')
      .trim()
      .replace(/\.+$/, '')
    if (one !== out) stages.push('terminal')
    out = one
  }
  const snippets = expandSnippets(out, opts.snippets ?? [], opts.snippetContext)
  if (snippets.expanded.length) stages.push('snippets')
  out = normalizeWhitespace(snippets.text)
  const empty = !isMeaningful(out)
  if (!empty) out = applyTrailing(out, opts.trailingSpace && !out.endsWith('\n'))
  return { text: empty ? '' : out, empty, stages, snippetsExpanded: snippets.expanded }
}
