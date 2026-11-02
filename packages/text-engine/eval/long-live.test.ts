import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../src/format'
import { layoutText } from '../src/layout'
import { joinPieces, seamContext, stripEcho } from '../src/seam'
import type { ChatMessage, ChatOptions, ChatResult } from '../src/types'
import { cutPieces, loadLongSamples, rng, scoreLayout, scoreSeams } from './long'

/**
 * Long dictations against a real model, the way the apps finish them: each streamed piece
 * formatted on its own with the end of the piece before as context, the pieces joined, then the
 * paragraph and list layout over the whole text.
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=https://api.groq.com/openai/v1 MURMUR_API_KEY=... \
 *   MURMUR_LLM_MODEL=openai/gpt-oss-20b npx vitest run eval/long-live.test.ts
 *
 * Optional: MURMUR_LAYOUT_MODEL (default: the same model), MURMUR_LONG_CUTS (cuttings per sample,
 * default 3), MURMUR_SEAM_WORDS (context words from the piece before, default 12, as the apps).
 * Prints a summary and writes eval/last-long-live.json with every piece, answer and score.
 */

const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_LLM_MODEL ?? ''
const layoutModel = process.env.MURMUR_LAYOUT_MODEL ?? model
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl && !!model
const CUTS = Number(process.env.MURMUR_LONG_CUTS ?? '3')
const SEAM_WORDS = Number(process.env.MURMUR_SEAM_WORDS ?? '12')

/** What the apps tell the formatter about a piece that is not the last (desktop session.ts). */
const PIECE_NOTE =
  'This transcript is one part of a longer dictation and may stop mid-sentence; if it does, leave the end unpunctuated.'

const completeWith =
  (m: string) =>
  async (messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: m,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 1024,
        ...(process.env.MURMUR_REASONING ? { reasoning_effort: process.env.MURMUR_REASONING } : {}),
        stream: false
      })
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      finishReason: json.choices?.[0]?.finish_reason
    }
  }

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0
}

describe.skipIf(!enabled)('long dictations (live)', () => {
  it(
    `formats, joins and lays out long dictations with ${model}`,
    async () => {
      const complete = completeWith(model)
      const completeLayout = completeWith(layoutModel)
      const runs: unknown[] = []
      const seams = {
        seams: 0,
        words: 0,
        wordErrors: 0,
        falseBreaks: 0,
        missedBreaks: 0,
        falseCaps: 0
      }
      const layout = {
        paraExpected: 0,
        paraFound: 0,
        paraMatched: 0,
        itemExpected: 0,
        itemFound: 0,
        itemMatched: 0
      }
      const pieceMs: number[] = []
      const layoutMs: number[] = []
      const outcomes: Record<string, number> = {}
      for (const s of loadLongSamples())
        for (let c = 0; c < CUTS; c++) {
          const pieces = cutPieces(s.spoken, rng(c * 104729 + s.id.length))
          // Pieces are formatted concurrently while recording; here one after another is fine.
          const formatted: string[] = []
          for (let i = 0; i < pieces.length; i++) {
            const before = i ? pieces[i - 1] : ''
            const last = i === pieces.length - 1
            const prior = seamContext(before, SEAM_WORDS)
            const r = await formatTranscript(
              {
                transcript: pieces[i],
                mode: 'smart',
                context: {
                  category: s.category,
                  tone: 'neutral',
                  dictionary: [],
                  precedingText: prior || undefined,
                  instructions: last ? undefined : PIECE_NOTE
                }
              },
              complete
            )
            pieceMs.push(r.llmMs)
            outcomes[r.status.outcome] = (outcomes[r.status.outcome] ?? 0) + 1
            formatted.push(stripEcho(r.text, prior))
          }
          const joined = joinPieces(formatted).text
          const laid = await layoutText(joined, s.category, completeLayout)
          layoutMs.push(laid.llmMs)
          const sc = scoreSeams(s.spoken, joined)
          seams.seams += pieces.length - 1
          seams.words += sc.words
          seams.wordErrors += Math.round(sc.wer * sc.words)
          seams.falseBreaks += sc.falseBreaks
          seams.missedBreaks += sc.missedBreaks
          seams.falseCaps += sc.falseCaps
          const ly = scoreLayout(s, laid.text)
          layout.paraExpected += ly.paragraphs.expected
          layout.paraFound += ly.paragraphs.found
          layout.paraMatched += ly.paragraphs.matched
          layout.itemExpected += ly.items.expected
          layout.itemFound += ly.items.found
          layout.itemMatched += ly.items.matched
          runs.push({
            id: s.id,
            cut: c,
            pieces,
            formatted,
            joined,
            layout: laid,
            seams: sc,
            layoutScore: ly
          })
          console.log(
            `${s.id} #${c}: ${JSON.stringify(sc)} layout ${laid.outcome} ${JSON.stringify(ly)}`
          )
        }
      const summary = {
        model,
        layoutModel,
        seamWords: SEAM_WORDS,
        cutsPerSample: CUTS,
        formatOutcomes: outcomes,
        // Word error against what was said: formatting may change "twentieth" to "20th", so this
        // is fidelity (how much the model rewrote), not recognition accuracy.
        werPercent: +((100 * seams.wordErrors) / seams.words).toFixed(2),
        falseBreaksPerSeam: +(seams.falseBreaks / seams.seams).toFixed(3),
        missedBreaksPerSeam: +(seams.missedBreaks / seams.seams).toFixed(3),
        falseCapsPerSeam: +(seams.falseCaps / seams.seams).toFixed(3),
        paragraphRecall: +(layout.paraMatched / layout.paraExpected).toFixed(3),
        paragraphsFoundPerExpected: +(layout.paraFound / layout.paraExpected).toFixed(2),
        listItemRecall: +(layout.itemMatched / layout.itemExpected).toFixed(3),
        listItemPrecision: +(layout.itemMatched / Math.max(1, layout.itemFound)).toFixed(3),
        pieceFormatMs: { p50: pct(pieceMs, 0.5), p95: pct(pieceMs, 0.95) },
        layoutMs: { p50: pct(layoutMs, 0.5), p95: pct(layoutMs, 0.95) }
      }
      console.log(JSON.stringify(summary, null, 2))
      writeFileSync(
        resolve(import.meta.dirname, 'last-long-live.json'),
        JSON.stringify({ summary, runs }, null, 2)
      )
      expect(runs.length).toBeGreaterThan(0)
    },
    30 * 60_000
  )
})
