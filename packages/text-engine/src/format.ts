import { basicCleanup, prepareTranscript } from './cleanup'
import { buildFormatMessages, maxTokensFor } from './prompt'
import { countWords, isMeaningful } from './text'
import type { ChatResult, Complete, FormatContext, FormatResult, FormattingMode } from './types'
import { cleanModelOutput, verifyOutput } from './verify'

export interface FormatInput {
  /** The transcript as the speech model returned it. */
  transcript: string
  mode: FormattingMode
  context: FormatContext
  /** Fewer words than this and the model is not worth a round trip (default 3). */
  minWords?: number
  /** One more attempt in strict mode after a rejected answer (default true). */
  retry?: boolean
  /** Include the worked examples in the prompt (default true). */
  examples?: boolean
}

const now = (): number => Date.now()

/**
 * Raw transcript in, text to insert out. `complete` is one chat completion; the engine decides
 * whether to call it, what to send, whether to believe the answer, and what to insert otherwise.
 * Never throws: every failure degrades to the rule-based cleanup with a status that says why.
 */
export async function formatTranscript(
  input: FormatInput,
  complete: Complete | null
): Promise<FormatResult> {
  const prepared = prepareTranscript(input.transcript)
  const base: Omit<FormatResult, 'text' | 'status' | 'stages'> = {
    pressEnter: prepared.pressEnter,
    llmMs: 0
  }
  const fallback = (
    outcome: FormatResult['status']['outcome'],
    detail: string | undefined,
    extra: Partial<FormatResult> = {},
    attempts = 0,
    retriedAfter?: string
  ): FormatResult => {
    if (input.mode === 'off') {
      return {
        ...base,
        ...extra,
        text: prepared.text,
        status: { outcome, detail, attempts, retriedAfter },
        stages: prepared.stages
      }
    }
    const light = basicCleanup(prepared.text, { dictionary: input.context.dictionary })
    return {
      ...base,
      ...extra,
      text: light.text,
      status: { outcome, detail, attempts, retriedAfter },
      stages: [...prepared.stages, ...light.stages]
    }
  }

  if (input.mode !== 'smart') return fallback('skipped', input.mode === 'off' ? 'formatting off' : 'light mode')
  if (!isMeaningful(prepared.text)) return fallback('skipped', 'nothing to format')
  if (!complete) return fallback('skipped', 'no model configured')
  const minWords = input.minWords ?? 3
  if (countWords(prepared.text) < minWords) return fallback('skipped', `shorter than ${minWords} words`)

  const started = now()
  let attempts = 0
  let firstReason: string | undefined
  let lastModelText: string | undefined
  const maxAttempts = input.retry === false ? 1 : 2

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++
    let res: ChatResult
    try {
      res = await complete(
        buildFormatMessages(prepared.text, input.context, {
          strict: attempt > 0,
          examples: input.examples
        }),
        { maxTokens: maxTokensFor(prepared.text), temperature: 0 }
      )
    } catch (err) {
      return fallback(
        'failed',
        err instanceof Error ? err.message : String(err),
        { llmMs: now() - started, modelText: lastModelText },
        attempts,
        firstReason
      )
    }
    const text = cleanModelOutput(res.text, prepared.text)
    lastModelText = text
    const verdict =
      res.finishReason === 'length'
        ? ({ ok: false, reason: 'too-long' } as const)
        : verifyOutput(prepared.text, text)
    if (verdict.ok) {
      return {
        ...base,
        text,
        modelText: text,
        llmMs: now() - started,
        status: { outcome: 'used', attempts, retriedAfter: firstReason },
        stages: [...prepared.stages, attempt > 0 ? 'llm-strict' : 'llm']
      }
    }
    const detail =
      verdict.reason === 'numbers-changed'
        ? `numbers-changed (${verdict.expected} -> ${verdict.actual})`
        : (verdict.reason ?? 'rejected')
    if (attempt === 0) firstReason = detail
    else {
      return fallback(
        'rejected',
        detail,
        { llmMs: now() - started, modelText: text },
        attempts,
        firstReason
      )
    }
  }
  return fallback('rejected', firstReason, { llmMs: now() - started, modelText: lastModelText }, attempts)
}
