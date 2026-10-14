import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { formatTranscript } from '../src/format'
import type { ChatMessage, ChatOptions, ChatResult } from '../src/types'

/**
 * Per-piece formatting on real speech, the way streamed precision dictation formats it:
 *
 *   MURMUR_PIECES=path/to/pieces.json MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_LLM_MODEL=...
 *   [MURMUR_REASONING=low] npx vitest run eval/pieces.test.ts
 *
 * pieces.json maps a recording name to its streamed STT pieces. Reports latency, line breaks the
 * model added, word runs it repeated that the piece did not repeat, and word error against the
 * piece (fidelity: formatting should not change the words much).
 */
const file = process.env.MURMUR_PIECES ?? ''
const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_LLM_MODEL ?? ''

async function complete(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 1024,
      ...(process.env.MURMUR_REASONING ? { reasoning_effort: process.env.MURMUR_REASONING } : {}),
      stream: false
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  }
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    finishReason: json.choices?.[0]?.finish_reason
  }
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    prev = cur
  }
  return ref.length ? prev[hyp.length] / ref.length : 0
}

const breaks = (s: string): number => (s.match(/\n/g) ?? []).length

describe.skipIf(!file || !baseUrl || !model)('per-piece formatting on real speech (live)', () => {
  it('reports', async () => {
    const { repeatedRuns } = await import('../src/verify')
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>
    const rows: unknown[] = []
    const ms: number[] = []
    let added = 0
    let rep = 0
    let n = 0
    let w = 0
    let notUsed = 0
    // MURMUR_PACE_MS: start piece i at i * pace, recordings side by side (a client streams one
    // piece per ~15 s); unset fires every piece of a recording at once.
    const pace = Number(process.env.MURMUR_PACE_MS ?? '0')
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const all = await Promise.all(
      Object.entries(data).map(async ([name, pieces]) => {
        const results = await Promise.all(
          pieces.map(async (p, i) => {
            if (pace) await sleep(i * pace)
            return formatTranscript(
            { transcript: p, mode: 'smart', context: { category: 'document', tone: 'neutral', language: 'auto', dictionary: [] } as never },
            complete
            )
          })
        )
        return [name, pieces, results] as const
      })
    )
    for (const [name, pieces, results] of all) {
      results.forEach((r, i) => {
        const p = pieces[i]
        n++
        ms.push(r.llmMs)
        const nl = Math.max(0, breaks(r.text) - breaks(p))
        const rp = repeatedRuns(p, r.text)
        const e = wer(words(p), words(r.text))
        if (nl) added++
        if (rp.length) rep++
        if (r.status.outcome !== 'used') notUsed++
        w += e
        if (nl || rp.length || r.status.outcome !== 'used')
          console.log(
            `[pieces] ${name}#${i} ${JSON.stringify(r.status)} newlines+${nl} repeats=${JSON.stringify(rp)} -> ${JSON.stringify(r.text)}`
          )
        rows.push({ name, i, input: p, output: r.text, status: r.status, ms: r.llmMs, nl, rp, wer: e })
      })
    }
    ms.sort((a, b) => a - b)
    const q = (x: number): number => ms[Math.min(ms.length - 1, Math.floor(ms.length * x))]
    const tag = process.env.MURMUR_REASONING ?? 'default'
    console.log(
      `[pieces] ${model} reasoning=${tag} n=${n} p50=${q(0.5)}ms p95=${q(0.95)}ms addedNewlines=${added} repeated=${rep} notUsed=${notUsed} meanWerVsInput=${(w / n).toFixed(3)}`
    )
    writeFileSync(file.replace(/\.json$/, `-${tag}.out.json`), JSON.stringify(rows, null, 1))
  }, 900_000)
})
