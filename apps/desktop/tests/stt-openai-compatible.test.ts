import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleStt, spansFromVerbose } from '@core/stt/openai-compatible'
import type { SttConfig } from '@core/stt/types'

const cfg = (baseUrl: string): SttConfig => ({
  kind: 'openai-compatible',
  baseUrl,
  apiKey: 'k',
  model: 'whisper-1',
  language: 'auto',
  timeoutMs: 5000
})
const wav = new Uint8Array(64)

interface Seen {
  fields: Record<string, string[]>
}

/** Fake server: records the multipart fields of each request and answers from a script. */
function serve(responses: Array<{ status: number; body: unknown }>): Seen[] {
  const seen: Seen[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      const fields: Record<string, string[]> = {}
      form.forEach((v, k) => {
        if (typeof v === 'string') (fields[k] ??= []).push(v)
      })
      seen.push({ fields })
      const next = responses.shift() ?? { status: 500, body: { error: 'out of script' } }
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
  return seen
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenAiCompatibleStt', () => {
  it('asks for verbose json with word timestamps and reports word spans', async () => {
    const seen = serve([
      {
        status: 200,
        body: {
          text: 'hello world',
          duration: 2,
          segments: [{ start: 0, end: 30, no_speech_prob: 0.1 }],
          words: [
            { word: 'hello', start: 0.2, end: 0.6 },
            { word: 'world', start: 0.7, end: 1.1 }
          ]
        }
      }
    ])
    const out = await new OpenAiCompatibleStt().transcribe(
      { wav, prompt: 'Vocabulary: x. Dictation with punctuation.' },
      cfg('http://a.test/v1')
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].fields.response_format).toEqual(['verbose_json'])
    expect(seen[0].fields['timestamp_granularities[]']).toEqual(['word', 'segment'])
    expect(seen[0].fields.prompt).toEqual(['Vocabulary: x. Dictation with punctuation.'])
    expect(out.text).toBe('hello world')
    // Word timings win over the segment that runs to the end of its window.
    expect(out.spans).toEqual([
      { start: 0.2, end: 0.6 },
      { start: 0.7, end: 1.1 }
    ])
  })

  it('retries without word timestamps when a server rejects them, and remembers that', async () => {
    const seen = serve([
      { status: 400, body: { error: { message: 'unknown field timestamp_granularities' } } },
      { status: 200, body: { text: 'ok', segments: [{ start: 0, end: 1.5 }] } },
      { status: 200, body: { text: 'again', segments: [{ start: 0, end: 1 }] } }
    ])
    const stt = new OpenAiCompatibleStt()
    const first = await stt.transcribe({ wav }, cfg('http://b.test/v1'))
    expect(first.text).toBe('ok')
    expect(first.spans).toEqual([{ start: 0, end: 1.5 }])
    expect(seen[1].fields['timestamp_granularities[]']).toBeUndefined()
    expect(seen[1].fields.response_format).toEqual(['verbose_json'])
    await stt.transcribe({ wav }, cfg('http://b.test/v1'))
    expect(seen).toHaveLength(3)
    expect(seen[2].fields['timestamp_granularities[]']).toBeUndefined()
  })

  it('falls back to plain json after a generic 400, then to the real error', async () => {
    const seen = serve([
      { status: 400, body: { error: { message: "response_format 'verbose_json' not supported" } } },
      { status: 400, body: { error: { message: "response_format 'verbose_json' not supported" } } },
      { status: 200, body: { text: 'plain' } }
    ])
    const out = await new OpenAiCompatibleStt().transcribe({ wav }, cfg('http://c.test/v1'))
    expect(out.text).toBe('plain')
    expect(out.spans).toBeUndefined()
    expect(seen.map((s) => s.fields.response_format[0])).toEqual([
      'verbose_json',
      'verbose_json',
      'json'
    ])

    serve([
      { status: 400, body: { error: { message: 'model whisper-1 does not exist' } } },
      { status: 400, body: { error: { message: 'model whisper-1 does not exist' } } }
    ])
    await expect(
      new OpenAiCompatibleStt().transcribe({ wav }, cfg('http://d.test/v1'))
    ).rejects.toMatchObject({ kind: 'model', status: 400 })
  })

  it('reads spans from words, then segments, and ignores malformed entries', () => {
    expect(spansFromVerbose(undefined)).toBeUndefined()
    expect(spansFromVerbose({ segments: [{ no_speech_prob: 0.2 }] })).toBeUndefined()
    expect(spansFromVerbose({ segments: [{ start: 0, end: 4 }, { start: 'x' as never }] })).toEqual(
      [{ start: 0, end: 4 }]
    )
    expect(
      spansFromVerbose({ segments: [{ start: 0, end: 30 }], words: [{ start: 1, end: 2 }] })
    ).toEqual([{ start: 1, end: 2 }])
  })
})
