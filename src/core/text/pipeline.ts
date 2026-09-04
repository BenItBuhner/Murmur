import type { DictionaryEntry, Snippet } from '@shared/settings'
import {
  applyLineCommands,
  applyLiteralPunctuation,
  applyScratchThat,
  extractPressEnter
} from './commands'
import { applySelfCorrections } from './corrections'
import { applyDictionary } from './dictionary'
import { collapseRepeats, removeFillers } from './fillers'
import {
  applyTrailing,
  capitalizeSentences,
  fixPunctuationSpacing,
  isMeaningful,
  normalizeWhitespace
} from './format'
import { expandSnippets, type SnippetContext } from './snippets'
import { countWords } from './util'

export interface PipelineOptions {
  removeFillers: boolean
  fillerWords: readonly string[]
  collapseRepeats: boolean
  spokenCommands: boolean
  selfCorrections: boolean
  autoCapitalize: boolean
  trailingSpace: boolean
  pressEnterCommand: boolean
  dictionary: readonly DictionaryEntry[]
  snippets: readonly Snippet[]
  snippetContext?: SnippetContext
}

export interface PipelineResult {
  text: string
  pressEnter: boolean
  wordCount: number
  snippetsExpanded: string[]
  /** Names of stages that changed the text; useful for the History view and debugging. */
  stages: string[]
  empty: boolean
}

/**
 * Deterministic cleanup that runs on every dictation, with or without the LLM stage.
 * Fast (microseconds) and predictable, so it doubles as the fallback whenever the
 * smart-formatting model is slow, unavailable, or returns something suspicious.
 */
export function runPipeline(raw: string, opts: PipelineOptions): PipelineResult {
  const stages: string[] = []
  let text = normalizeWhitespace(raw)
  let pressEnter = false

  const step = (name: string, fn: (s: string) => string): void => {
    const next = fn(text)
    if (next !== text) stages.push(name)
    text = next
  }

  if (opts.spokenCommands) {
    if (opts.pressEnterCommand) {
      const r = extractPressEnter(text)
      if (r.pressEnter) {
        stages.push('press-enter')
        pressEnter = true
        text = r.text
      }
    }
    step('scratch-that', applyScratchThat)
    step('line-commands', applyLineCommands)
    step('literal-punctuation', applyLiteralPunctuation)
  }
  if (opts.removeFillers) step('fillers', (s) => removeFillers(s, opts.fillerWords))
  if (opts.collapseRepeats) step('repeats', collapseRepeats)
  if (opts.selfCorrections) step('self-corrections', applySelfCorrections)
  step('dictionary', (s) => applyDictionary(s, opts.dictionary))
  step('punctuation', fixPunctuationSpacing)
  if (opts.autoCapitalize) step('capitalize', capitalizeSentences)
  text = normalizeWhitespace(text)

  const snippetResult = expandSnippets(text, opts.snippets, opts.snippetContext)
  if (snippetResult.expanded.length) stages.push('snippets')
  text = snippetResult.text

  const empty = !isMeaningful(text)
  if (!empty)
    text = applyTrailing(text, { trailingSpace: opts.trailingSpace && !text.endsWith('\n') })

  return {
    text: empty ? '' : text,
    pressEnter,
    wordCount: countWords(text),
    snippetsExpanded: snippetResult.expanded,
    stages,
    empty
  }
}

/** Second pass after the LLM: re-assert dictionary spellings and layout rules only. */
export function finalizeAfterLlm(llmText: string, opts: PipelineOptions): PipelineResult {
  const stages: string[] = ['llm']
  let text = normalizeWhitespace(llmText)
  const dict = applyDictionary(text, opts.dictionary)
  if (dict !== text) stages.push('dictionary')
  text = fixPunctuationSpacing(dict)
  const snippetResult = expandSnippets(text, opts.snippets, opts.snippetContext)
  if (snippetResult.expanded.length) stages.push('snippets')
  text = normalizeWhitespace(snippetResult.text)
  const empty = !isMeaningful(text)
  if (!empty)
    text = applyTrailing(text, { trailingSpace: opts.trailingSpace && !text.endsWith('\n') })
  return {
    text: empty ? '' : text,
    text: empty ? '' : text,
    pressEnter: false,
    wordCount: countWords(text),
    snippetsExpanded: snippetResult.expanded,
    stages,
    empty
  }
}
