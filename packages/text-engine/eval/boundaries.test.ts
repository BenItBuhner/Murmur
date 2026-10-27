import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatTranscript } from '../src/format'
import type { ChatMessage, ChatOptions, ChatResult, FormatContext } from '../src/types'

/**
 * Sentence boundaries against a real model: the speech model ends a sentence wherever the speaker
 * paused, and the formatter must join the pieces that cannot stand alone ("I want you to dig
 * deeper. And actually merge it yourself.") without merging real sentences ("That's awful.
 * That's bad.").
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_LLM_MODEL=complete \
 *   [MURMUR_BOUNDARY_FIXTURES=other.json] [MURMUR_BOUNDARY_OUT=run.json] npx vitest run eval/boundaries.test.ts
 *
 * A fixture lists word pairs around a break in its transcript: `join` pairs must end up in one
 * sentence, `keep` pairs must keep a sentence end between them. Each side is a regex source
 * matched as a whole word, case-insensitively.
 */

export interface BoundaryFixture {
  id: string
  transcript: string
  context?: Partial<FormatContext>
  join: [string, string][]
  keep: [string, string][]
}

export type BoundaryVerdict = 'joined' | 'kept' | 'missing'

/** Whether the output put a sentence end between `a` and the `b` that follows it. */
export function boundaryVerdict(text: string, a: string, b: string): BoundaryVerdict {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}'’])(?:${a})(?![\\p{L}\\p{N}'’])([^\\p{L}\\p{N}]*)(?<![\\p{L}\\p{N}'’])(?:${b})(?![\\p{L}\\p{N}'’])`,
    'iu'
  )
  const m = re.exec(text.replace(/’/g, "'"))
  if (!m) return 'missing'
  return /[.!?…]/u.test(m[1]) ? 'kept' : 'joined'
}

const baseUrl = (process.env.MURMUR_BASE_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_LLM_MODEL ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl && !!model

async function complete(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 1024,
        ...(process.env.MURMUR_REASONING ? { reasoning_effort: process.env.MURMUR_REASONING } : {}),
        stream: false
      })
    })
    if (res.status === 429 || res.status === 503) throw new Error(`proxy busy (HTTP ${res.status}); stopping`)
    if (!res.ok) {
      if (i < 2) continue
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      usage?: ChatResult['usage']
    }
    return { text: json.choices?.[0]?.message?.content ?? '', finishReason: json.choices?.[0]?.finish_reason, usage: json.usage }
  }
}

describe('boundaryVerdict', () => {
  it('reads joins and breaks', () => {
    expect(boundaryVerdict('dig deeper and actually merge', 'deeper', 'and')).toBe('joined')
    expect(boundaryVerdict('dig deeper, and actually merge', 'deeper', 'and')).toBe('joined')
    expect(boundaryVerdict('dig deeper. And actually merge', 'deeper', 'and')).toBe('kept')
    expect(boundaryVerdict('months 3, 4, 5, and 6', 'five|5', 'and')).toBe('joined')
    expect(boundaryVerdict('nothing here', 'deeper', 'and')).toBe('missing')
  })
})

describe.skipIf(!enabled)('sentence boundaries (live)', () => {
  it(`joins fragments and keeps sentences with ${model}`, async () => {
    const file = process.env.MURMUR_BOUNDARY_FIXTURES ?? resolve(__dirname, 'boundaries.json')
    const fixtures = JSON.parse(readFileSync(file, 'utf8')) as BoundaryFixture[]
    const runs = Number(process.env.MURMUR_BOUNDARY_RUNS ?? 1)
    let joinOk = 0
    let joinN = 0
    let keepOk = 0
    let keepN = 0
    const out: unknown[] = []
    for (let r = 0; r < runs; r++)
      for (const f of fixtures) {
        const context: FormatContext = { category: 'chat', tone: 'casual', dictionary: [], language: 'auto', ...f.context }
        const result = await formatTranscript({ transcript: f.transcript, mode: 'smart', context, cleanMaxWords: 0 }, complete)
        const verdicts = {
          join: f.join.map(([a, b]) => boundaryVerdict(result.text, a, b)),
          keep: f.keep.map(([a, b]) => boundaryVerdict(result.text, a, b))
        }
        joinN += f.join.length
        keepN += f.keep.length
        joinOk += verdicts.join.filter((v) => v === 'joined').length
        keepOk += verdicts.keep.filter((v) => v === 'kept').length
        const bad = verdicts.join.some((v) => v !== 'joined') || verdicts.keep.some((v) => v !== 'kept')
        console.log(`${bad ? 'MISS' : 'ok  '} ${f.id} [${result.status.outcome}] ${JSON.stringify(result.text)}`)
        out.push({ id: f.id, text: result.text, status: result.status, verdicts })
      }
    console.log(`\n[boundaries] ${model}: fragments joined ${joinOk}/${joinN}, sentences kept ${keepOk}/${keepN}`)
    if (process.env.MURMUR_BOUNDARY_OUT) writeFileSync(process.env.MURMUR_BOUNDARY_OUT, JSON.stringify(out, null, 2))
    expect(keepOk / Math.max(1, keepN)).toBeGreaterThanOrEqual(Number(process.env.MURMUR_BOUNDARY_MIN_KEEP ?? 0.9))
  })
})
