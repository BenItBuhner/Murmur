import type { DictionaryEntry, Settings } from '@shared/settings'
import type { LlmStatus } from '@shared/types'
import {
  chatComplete,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type LlmConfig
} from '@core/llm/client'
import type { AppContext, ResolvedStyle } from './app-context'
import { hesitationWords } from './hesitations'
import { buildFormatMessages, maxTokensFor } from './llm-prompt'
import { reviewLlmOutput, type ReviewDetail, type ReviewPolicy } from './llm-review'
import { finalizeAfterLlm, type PipelineOptions, type PipelineResult } from './pipeline'

export type Complete = (
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts?: ChatOptions
) => Promise<ChatResult>

export interface SmartFormatInput {
  /** Deterministic pipeline output; the model polishes this, not the raw transcript. */
  light: PipelineResult
  formatting: Settings['formatting']
  dictionary: readonly DictionaryEntry[]
  style: ResolvedStyle
  app: AppContext
  llm: LlmConfig
  pipelineOpts: PipelineOptions
  precedingText?: string
}

export interface SmartFormatResult {
  /** What should be inserted: the reviewed model text, or `light` when the model was not used. */
  result: PipelineResult
  status: LlmStatus
  llmMs: number
  /** Cleaned model output before the review, for the settings playground. */
  modelText?: string
  review?: ReviewDetail[]
  finishReason?: string
}

/** Why the model would not be asked for this dictation, or null when it should be. */
export function skipReason(
  input: Pick<SmartFormatInput, 'light' | 'formatting' | 'style' | 'llm'>
): string | null {
  if (input.style.mode !== 'smart')
    return input.style.mode === 'off' ? 'formatting off' : 'light mode'
  if (input.light.empty) return 'nothing to format'
  if (!input.llm.baseUrl || !input.llm.model) return 'no model configured'
  if (input.light.wordCount < input.formatting.llm.minWords)
    return `shorter than ${input.formatting.llm.minWords} words`
  if (input.light.snippetsExpanded.length) return 'snippet expanded'
  return null
}

export function reviewPolicyFor(
  input: Pick<SmartFormatInput, 'formatting' | 'dictionary' | 'style' | 'light'>
): ReviewPolicy {
  const f = input.formatting
  const droppable = new Set<string>()
  for (const w of f.fillerWords) droppable.add(w.trim().toLowerCase())
  for (const w of hesitationWords({
    level: f.hesitations === 'off' ? 'light' : f.hesitations,
    custom: f.hesitationPhrases
  }))
    droppable.add(w)
  const protectedTerms = new Set<string>()
  for (const d of input.dictionary) {
    const w = d.word.trim().toLowerCase()
    if (w && !/\s/.test(w)) protectedTerms.add(w)
  }
  return {
    freedom: input.style.freedom,
    droppable,
    protectedTerms,
    allowNewLines: input.style.structure === 'assist' && input.style.lists !== 'off',
    preserveLayout: input.light.hints.listApplied || input.light.hints.hasLineBreaks
  }
}

/**
 * The smart-formatting stage: decide, ask, verify. Never throws; every failure mode degrades to
 * the deterministic text with a status that explains what happened.
 */
export async function smartFormat(
  input: SmartFormatInput,
  complete: Complete = chatComplete
): Promise<SmartFormatResult> {
  const skipped = skipReason(input)
  if (skipped)
    return { result: input.light, status: { outcome: 'skipped', detail: skipped }, llmMs: 0 }

  const started = performance.now()
  const lightText = input.light.text.trim()
  let res: ChatResult
  try {
    res = await complete(
      input.llm,
      buildFormatMessages({
        raw: lightText,
        dictionary: input.dictionary,
        style: input.style,
        app: input.app,
        hints: input.light.hints,
        precedingText: input.precedingText,
        examples: input.formatting.llm.examples
      }),
      { maxTokens: maxTokensFor(lightText, input.formatting.llm.maxTokensMultiplier) }
    )
  } catch (err) {
    return {
      result: input.light,
      status: { outcome: 'failed', detail: err instanceof Error ? err.message : String(err) },
      llmMs: Math.round(performance.now() - started)
    }
  }
  const llmMs = Math.round(performance.now() - started)
  const review = reviewLlmOutput(res.text, lightText, reviewPolicyFor(input))
  if (review.outcome === 'rejected') {
    return {
      result: input.light,
      status: {
        outcome: 'rejected',
        detail: review.reason,
        accepted: review.accepted,
        reverted: review.reverted
      },
      llmMs,
      modelText: review.text,
      review: review.details,
      finishReason: res.finishReason
    }
  }
  const finalized = finalizeAfterLlm(review.text, {
    ...input.pipelineOpts,
    trailingSpace: input.style.trailingSpace
  })
  finalized.pressEnter = input.light.pressEnter
  if (finalized.empty) {
    return {
      result: input.light,
      status: {
        outcome: 'rejected',
        detail: 'empty',
        accepted: review.accepted,
        reverted: review.reverted
      },
      llmMs,
      modelText: review.text,
      review: review.details
    }
  }
  return {
    result: finalized,
    status: { outcome: review.outcome, accepted: review.accepted, reverted: review.reverted },
    llmMs,
    modelText: review.text,
    review: review.details,
    finishReason: res.finishReason
  }
}
