import type {
  BulletMarker,
  DictionaryEntry,
  HesitationLevel,
  ListStyle,
  ListsMode,
  NumbersMode,
  RepetitionScope,
  Snippet
} from '@shared/settings'
import {
  applyLineCommands,
  applyLiteralPunctuation,
  applyScratchThat,
  applySpokenQuotes,
  extractPressEnter
} from './commands'
import { applySelfCorrections } from './corrections'
import { applyDictionary } from './dictionary'
import { removeFillers } from './fillers'
import {
  applyTrailing,
  capitalizeSentences,
  fixPunctuationSpacing,
  isMeaningful,
  normalizeWhitespace
} from './format'
import { removeHesitations } from './hesitations'
import { detectListIntent, formatLists, normalizeListMarkers, type ListIntent } from './lists'
import { convertNumbers } from './numbers'
import { collapseRepeats } from './repeats'
import { expandSnippets, type SnippetContext } from './snippets'
import { countWords, isQuestion } from './util'

export interface PipelineOptions {
  removeFillers: boolean
  fillerWords: readonly string[]
  hesitations: HesitationLevel
  hesitationPhrases: readonly string[]
  collapseRepeats: boolean
  repetitionScope: RepetitionScope
  spokenCommands: boolean
  selfCorrections: boolean
  autoCapitalize: boolean
  trailingSpace: boolean
  pressEnterCommand: boolean
  lists: ListsMode
  listStyle: ListStyle
  bulletMarker: BulletMarker
  numbers: NumbersMode
  dictionary: readonly DictionaryEntry[]
  snippets: readonly Snippet[]
  snippetContext?: SnippetContext
}

/** What the deterministic pass learned about the text; the smart-formatting prompt uses it. */
export interface TextHints {
  list: ListIntent
  /** The rule-based stage already laid the text out as a list. */
  listApplied: boolean
  isQuestion: boolean
  hasLineBreaks: boolean
}

export interface PipelineResult {
  text: string
  pressEnter: boolean
  wordCount: number
  snippetsExpanded: string[]
  /** Names of stages that changed the text; useful for the History view and debugging. */
  stages: string[]
  empty: boolean
  hints: TextHints
}

const NO_HINTS: TextHints = {
  list: { requested: null, explicit: false, markers: 0 },
  listApplied: false,
  isQuestion: false,
  hasLineBreaks: false
}

/**
 * Deterministic cleanup that runs on every dictation, with or without the LLM stage.
 * Fast (microseconds) and predictable, so it doubles as the fallback whenever the
 * smart-formatting model is slow, unavailable, or returns something suspicious.
 *
 * Order matters: spoken commands first (they are structural), then the noise that hides
 * corrections ("um"), then the corrections themselves, then hesitation phrases and repeats
 * (which corrections may have exposed), then vocabulary, then structure (lists, numbers),
 * and finally presentation (spacing, casing, snippets).
 */
export function runPipeline(raw: string, opts: PipelineOptions): PipelineResult {
  const stages: string[] = []
  let text = normalizeWhitespace(raw)
  let pressEnter = false
  const hints: TextHints = { ...NO_HINTS }

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
    step('quotes', applySpokenQuotes)
  }
  if (opts.removeFillers) step('fillers', (s) => removeFillers(s, opts.fillerWords))
  if (opts.selfCorrections) step('self-corrections', applySelfCorrections)
  if (opts.hesitations !== 'off')
    step('hesitations', (s) =>
      removeHesitations(s, { level: opts.hesitations, custom: opts.hesitationPhrases })
    )
  if (opts.collapseRepeats) step('repeats', (s) => collapseRepeats(s, opts.repetitionScope))
  step('dictionary', (s) => applyDictionary(s, opts.dictionary))

  const list = formatLists(text, {
    mode: opts.lists,
    style: opts.listStyle,
    marker: opts.bulletMarker,
    capitalize: opts.autoCapitalize
  })
  hints.list = list.intent
  if (list.text !== text) {
    stages.push(list.applied ? 'lists' : 'list-request')
    text = list.text
  }
  hints.listApplied = list.applied

  if (opts.numbers !== 'off') step('numbers', (s) => convertNumbers(s, opts.numbers))
  step('punctuation', fixPunctuationSpacing)
  if (opts.autoCapitalize) step('capitalize', capitalizeSentences)
  text = normalizeWhitespace(text)

  const snippetResult = expandSnippets(text, opts.snippets, opts.snippetContext)
  if (snippetResult.expanded.length) stages.push('snippets')
  text = snippetResult.text

  const empty = !isMeaningful(text)
  if (!empty)
    text = applyTrailing(text, { trailingSpace: opts.trailingSpace && !text.endsWith('\n') })

  hints.isQuestion = isQuestion(text)
  hints.hasLineBreaks = text.includes('\n')

  return {
    text: empty ? '' : text,
    pressEnter,
    wordCount: countWords(text),
    snippetsExpanded: snippetResult.expanded,
    stages,
    empty,
    hints
  }
}

/**
 * Second pass after the LLM: re-assert dictionary spellings and layout rules only. The model
 * has already done the semantic work, so no filler/hesitation/list logic runs here.
 */
export function finalizeAfterLlm(llmText: string, opts: PipelineOptions): PipelineResult {
  const stages: string[] = ['llm']
  let text = normalizeWhitespace(llmText)
  text = normalizeListMarkers(text, opts.bulletMarker)
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
    pressEnter: false,
    wordCount: countWords(text),
    snippetsExpanded: snippetResult.expanded,
    stages,
    empty,
    hints: {
      ...NO_HINTS,
      list: detectListIntent(text),
      listApplied: /(?:^|\n)(?:[-•*]|\d+\.)\s/.test(text),
      isQuestion: isQuestion(text),
      hasLineBreaks: text.includes('\n')
    }
  }
}
