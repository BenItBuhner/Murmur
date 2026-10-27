import { CLEAN_MAX_WORDS, alreadyClean } from './clean'
import { basicCleanup, prepareTranscript } from './cleanup'
import { buildFormatMessages, maxTokensFor } from './prompt'
import { countWords, isMeaningful } from './text'
import type { ChatResult, Complete, FormatContext, FormatResult, FormattingMode } from './types'
import { cleanModelOutput, verifyOutput, repairCase, repairOutput } from './verify'

export interface FormatInput {
  /** The transcript as the speech model returned it. */
  transcript: string
  mode: FormattingMode
  context: FormatContext
  /** Fewer words than this and the model is not worth a round trip (default 3). */
  minWords?: number
  /**
   * Up to this many words, a transcript that is already clean (see `alreadyClean`) skips the
   * model and takes the rule-based cleanup (default {@link CLEAN_MAX_WORDS}; 0 never skips).
   */
  cleanMaxWords?: number
  /** One more attempt in strict mode after a rejected answer (default true). */
  retry?: boolean
  /** Include the worked examples in the prompt (default true). */
  examples?: boolean
  /**
   * Longer than this many words, the transcript is formatted as sentence-aligned pieces of about
   * {@link CHUNK_WORDS} words in parallel (default {@link CHUNK_ABOVE_WORDS}; 0 never splits).
   */
  chunkAboveWords?: number
}

/** Target piece size for parallel formatting of long dictations. */
export const CHUNK_WORDS = 120
/**
 * One completion over a five-minute dictation takes ~6.6 s (close to the gateway's 8 s format
 * budget) and very long ones overflow the token cap; seven parallel pieces take ~2 s with the
 * same words out (bench: Murmur speed notes, Oct 2026).
 */
export const CHUNK_ABOVE_WORDS = 200

/**
 * Split at sentence ends into pieces of at least `target` words (a short tail joins the last
 * piece). Returns the pieces and the original whitespace at each cut, so line breaks survive.
 */
export function splitForFormatting(
  text: string,
  target = CHUNK_WORDS
): { pieces: string[]; joins: string[] } {
  const parts = text.split(/(?<=[.!?…])(\s+)(?=\S)/u)
  const pieces: string[] = []
  const joins: string[] = []
  let cur = ''
  let words = 0
  for (let i = 0; i < parts.length; i += 2) {
    cur += parts[i]
    words += countWords(parts[i])
    const sep = parts[i + 1]
    if (sep === undefined) break
    if (words >= target) {
      pieces.push(cur)
      joins.push(sep)
      cur = ''
      words = 0
    } else cur += sep
  }
  if (cur) {
    if (pieces.length && words < target / 3) pieces[pieces.length - 1] += joins.pop()! + cur
    else pieces.push(cur)
  }
  return { pieces, joins }
}

const OUTCOME_RANK: Record<FormatResult['status']['outcome'], number> = {
  used: 0,
  'skipped-clean': 1,
  skipped: 2,
  rejected: 3,
  failed: 4
}

async function formatInPieces(
  input: FormatInput,
  { pieces, joins }: { pieces: string[]; joins: string[] },
  pressEnter: boolean,
  prepStages: string[],
  complete: Complete
): Promise<FormatResult> {
  const results = await Promise.all(
    pieces.map((piece) =>
      formatTranscript(
        { ...input, transcript: piece, chunkAboveWords: 0, cleanMaxWords: 0, minWords: 0 },
        complete
      )
    )
  )
  const worst = results.reduce((a, b) =>
    OUTCOME_RANK[b.status.outcome] > OUTCOME_RANK[a.status.outcome] ? b : a
  )
  const stages = [...prepStages]
  for (const r of results) for (const st of r.stages) if (!stages.includes(st)) stages.push(st)
  return {
    // Pieces were cut at sentence ends; they rejoin with the whitespace that was there.
    text: results.map((r, i) => r.text.trim() + (joins[i] ?? '')).join(''),
    pressEnter,
    modelText: results.every((r) => r.modelText !== undefined)
      ? results.map((r, i) => r.modelText!.trim() + (joins[i] ?? '')).join('')
      : undefined,
    llmMs: Math.max(...results.map((r) => r.llmMs)),
    status: {
      ...worst.status,
      attempts: Math.max(...results.map((r) => r.status.attempts)),
      detail: worst.status.outcome === 'used' ? `${pieces.length} pieces` : worst.status.detail
    },
    stages
  }
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

  if (input.mode !== 'smart')
    return fallback('skipped', input.mode === 'off' ? 'formatting off' : 'light mode')
  if (!isMeaningful(prepared.text)) return fallback('skipped', 'nothing to format')
  if (!complete) return fallback('skipped', 'no model configured')
  const minWords = input.minWords ?? 3
  if (countWords(prepared.text) < minWords)
    return fallback('skipped', `shorter than ${minWords} words`)
  // A short transcript the speech model already punctuated, with nothing in it the model would
  // change, is finished by the rules alone: the same text, no round trip, no tokens.
  if (alreadyClean(prepared, input.context, { maxWords: input.cleanMaxWords ?? CLEAN_MAX_WORDS }).clean)
    return fallback('skipped-clean', 'already clean')

  const chunkAbove = input.chunkAboveWords ?? CHUNK_ABOVE_WORDS
  if (chunkAbove > 0 && countWords(prepared.text) > chunkAbove) {
    const split = splitForFormatting(prepared.text)
    if (split.pieces.length > 1)
      return formatInPieces(input, split, prepared.pressEnter, prepared.stages, complete)
  }

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
    const text = repairOutput(prepared.text, cleanModelOutput(res.text, prepared.text))
    lastModelText = text
    const verdict =
      res.finishReason === 'length'
        ? ({ ok: false, reason: 'too-long' } as const)
        : verifyOutput(prepared.text, text, {
            language: input.context.language,
            keepVerbatim: input.context.keepVerbatim
          })
    if (verdict.ok) {
      const cased = repairCase(prepared.text, text, input.context)
      return {
        ...base,
        text: cased,
        modelText: text,
        llmMs: now() - started,
        status: { outcome: 'used', attempts, retriedAfter: firstReason },
        stages: [...prepared.stages, attempt > 0 ? 'llm-strict' : 'llm', ...(cased !== text ? ['case'] : [])]
      }
    }
    const detail =
      verdict.reason === 'numbers-changed'
        ? `numbers-changed (${verdict.expected} -> ${verdict.actual})`
        : verdict.reason === 'verbatim-lost'
          ? `verbatim-lost (${verdict.expected})`
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
  return fallback(
    'rejected',
    firstReason,
    { llmMs: now() - started, modelText: lastModelText },
    attempts
  )
}
