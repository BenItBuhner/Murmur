/**
 * Where the release time goes: the speech provider's latency by model and clip length, measured
 * from the runner, plus the bare round trip to the provider (GET /models) and the formatting
 * models on a short transcript. Each call is sequential so they never queue behind each other.
 *
 *   MURMUR_INFERENCE_STT_KEY=... MURMUR_INFERENCE_LLM_KEY=... npx tsx eval/probe.ts /tmp/stt-eval [n=8]
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '/tmp/stt-eval')
const n = Number(process.argv[3] ?? 3)
const base = 'https://infer.techlitnow.com/v1'
const sttKey = process.env.MURMUR_INFERENCE_STT_KEY ?? ''
const llmKey = process.env.MURMUR_INFERENCE_LLM_KEY ?? ''
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }
const stat = (xs: number[]) => `p50 ${q(xs, 0.5)} · p90 ${q(xs, 0.9)} · min ${q(xs, 0)} ms`

function trim(wav: Uint8Array, sec: number): Uint8Array {
  const bytes = Math.min(wav.length - 44, Math.round(sec * 32000))
  const out = new Uint8Array(44 + bytes)
  out.set(wav.subarray(0, 44 + bytes))
  const v = new DataView(out.buffer)
  v.setUint32(4, 36 + bytes, true)
  v.setUint32(40, bytes, true)
  return out
}

async function timed(f: () => Promise<Response>): Promise<{ ms: number; headers: Headers; ok: boolean; body: string; status: number }> {
  const t = performance.now()
  const r = await f()
  const body = await r.text()
  return { ms: performance.now() - t, headers: r.headers, ok: r.ok, body, status: r.status }
}

const lines: string[] = ['## Latency probe', '']
const rtt: number[] = []
for (let i = 0; i < n; i++) rtt.push((await timed(() => fetch(`${base}/models`, { headers: { authorization: `Bearer ${sttKey}` } }))).ms)
lines.push(`- GET /models (round trip to the provider): ${stat(rtt)}`)

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Array<{ file: string; kind: string }>
const wav = new Uint8Array(readFileSync(join(dir, manifest.find((m) => m.kind === 'test-clean')!.file)))
let printedHeaders = false
for (const model of ['murmur-fast-transcribe', 'transcribe-1', 'murmur-bg-transcribe']) {
  for (const sec of [1.5, 4, 10]) {
    const clip = trim(wav, sec)
    const ms: number[] = []
    let fails = 0
    for (let i = 0; i < n; i++) {
      const f = new FormData()
      f.append('file', new Blob([clip as BlobPart], { type: 'audio/wav' }), 'a.wav')
      f.append('model', model)
      f.append('temperature', '0')
      f.append('response_format', model === 'murmur-bg-transcribe' ? 'json' : 'verbose_json')
      const r = await timed(() => fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${sttKey}` }, body: f }))
      if (!r.ok) { if (!fails) lines.push(`  - ${model} error: HTTP ${r.status} after ${Math.round(r.ms)} ms: ${r.body.slice(0, 300)}`); fails++ }
      else ms.push(r.ms)
      if (!printedHeaders) {
        printedHeaders = true
        const h: string[] = []
        r.headers.forEach((v, k) => { if (!/cookie|auth/i.test(k)) h.push(`${k}: ${v}`) })
        lines.push(`- response headers (first call): ${h.join(' | ')}`)
      }
    }
    lines.push(`- ${model}, ${sec} s clip: ${ms.length ? stat(ms) : 'all failed'}${fails ? ` (${fails} failed)` : ''}`)
  }
}
const transcript = 'so I think we should ship the new onboarding flow on Monday and then check the numbers on Wednesday'
for (const model of ['murmur-fast-format', 'complete']) {
  const ms: number[] = []
  for (let i = 0; i < n; i++) {
    const r = await timed(() => fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${llmKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages: [{ role: 'system', content: 'Fix punctuation. Reply with the text only.' }, { role: 'user', content: transcript }] })
    }))
    if (r.ok) ms.push(r.ms)
  }
  lines.push(`- format ${model} (20-word transcript): ${ms.length ? stat(ms) : 'all failed'}`)
}
console.log(lines.join('\n'))
