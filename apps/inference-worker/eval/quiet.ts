/**
 * Quiet and muffled speech (a phone held low, a hand over the mic): the LibriSpeech clips at -20 and
 * -32 dB and through a 1 kHz low-pass, on each upstream speech model and the gateway's two tiers.
 * Deleted words per 100 is the number to watch.  npx tsx eval/quiet.ts /tmp/stt-eval [runs=2]
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { handleTranscriptions, type GatewayHooks } from '../../../packages/backend/convex/lib/gatewayCore'
import { STT_BASE_PROMPT } from '../../../packages/text-engine/src/dictionary'
import { wavPcm16 } from '../../../packages/text-engine/src/no-speech'
import { align } from './score'

const dir = resolve(process.argv[2] ?? '/tmp/stt-eval')
const runs = Number(process.argv[3] ?? 2)
const raw = readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8')
const vars = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as { vars: Record<string, string> }).vars
const env: Record<string, string> = { ...vars, MURMUR_INFERENCE_STT_KEY: process.env.MURMUR_INFERENCE_STT_KEY ?? '', MURMUR_INFERENCE_LLM_KEY: process.env.MURMUR_INFERENCE_LLM_KEY ?? '' }
const hooks = {
  env,
  access: async () => 'active',
  authorize: async () => ({ ok: true, userId: 'stt-eval', plan: 'free', planState: 'active', paused: null, provider: { failures: 0, openForSec: null } }),
  record: async () => {},
  providerFailed: async () => ({ failures: 0, openForSec: null }),
  providerRecovered: async () => {}
} as unknown as GatewayHooks

function wavOf(s: Int16Array): Uint8Array {
  const out = new Uint8Array(44 + s.length * 2), v = new DataView(out.buffer)
  const tag = (o: number, t: string) => { for (let i = 0; i < 4; i++) out[o + i] = t.charCodeAt(i) }
  tag(0, 'RIFF'); v.setUint32(4, 36 + s.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true)
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, s.length * 2, true)
  s.forEach((x, i) => v.setInt16(44 + i * 2, x, true))
  return out
}
const gain = (s: Int16Array, db: number) => s.map((x) => Math.round(x * 10 ** (db / 20)))
function muffle(s: Int16Array) { // two one-pole low-passes at ~1 kHz, then -12 dB
  const a = Math.exp((-2 * Math.PI * 1000) / 16000); let y1 = 0, y2 = 0
  return s.map((x) => { y1 = (1 - a) * x + a * y1; y2 = (1 - a) * y1 + a * y2; return Math.round(y2 * 0.25) })
}
const variants: Record<string, (s: Int16Array) => Int16Array> = { normal: (s) => s, '-20dB': (s) => gain(s, -20), '-32dB': (s) => gain(s, -32), muffled: muffle }

async function gateway(wav: Uint8Array, tier: string) {
  const f = new FormData()
  f.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  for (const [k, v] of Object.entries({ model: 'murmur-transcribe', response_format: 'verbose_json', temperature: '0', speed: 'normal', prompt: STT_BASE_PROMPT })) f.append(k, v)
  const res = await handleTranscriptions(hooks, { subject: 'stt-eval' }, new Request('https://eval.local/v1/audio/transcriptions', { method: 'POST', headers: { 'x-murmur-tier': tier }, body: f }))
  const body = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 120)}`)
  return { text: (JSON.parse(body) as { text?: string }).text ?? '', role: (JSON.parse(res.headers.get('x-murmur-trace') ?? '{}') as { role?: string }).role ?? '?' }
}
async function direct(wav: Uint8Array, model: string, plain: boolean) {
  const f = new FormData()
  f.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  for (const [k, v] of Object.entries({ model, response_format: plain ? 'json' : 'verbose_json', temperature: '0', prompt: STT_BASE_PROMPT })) f.append(k, v)
  const res = await fetch(`${env.MURMUR_INFERENCE_STT_URL}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${env.MURMUR_INFERENCE_STT_KEY}` }, body: f, signal: AbortSignal.timeout(30_000) })
  const body = await res.text()
  if (!res.ok) throw new Error(`${model} ${res.status}`)
  return { text: (JSON.parse(body) as { text?: string }).text ?? '', role: model }
}
const arms: Record<string, (w: Uint8Array) => Promise<{ text: string; role: string }>> = {
  'gateway release': (w) => gateway(w, 'release'),
  'gateway background': (w) => gateway(w, 'background'),
  [`fast ${env.MURMUR_INFERENCE_STT_FAST_MODEL}`]: (w) => direct(w, env.MURMUR_INFERENCE_STT_FAST_MODEL!, false),
  [`normal ${env.MURMUR_INFERENCE_STT_MODEL}`]: (w) => direct(w, env.MURMUR_INFERENCE_STT_MODEL!, false),
  [`hedge ${env.MURMUR_INFERENCE_STT_HEDGE_MODEL}`]: (w) => direct(w, env.MURMUR_INFERENCE_STT_HEDGE_MODEL!, true)
}
const clips = (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { file: string; ref: string; kind: string }[]).filter((c) => c.kind.startsWith('test-'))
const tot = new Map<string, { n: number; d: number; e: number; fail: number }>()
const roles = new Map<string, number>()
const worst: string[] = []
const jobs = clips.flatMap((c) => Object.keys(variants).flatMap((v) => Object.keys(arms).flatMap((a) => Array.from({ length: runs }, () => ({ c, v, a })))))
const q = [...jobs]
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let j = q.shift(); j; j = q.shift()) {
    const key = `${j.v} | ${j.a}`
    const t = tot.get(key) ?? { n: 0, d: 0, e: 0, fail: 0 }; tot.set(key, t)
    try {
      const pcm = wavPcm16(new Uint8Array(readFileSync(join(dir, j.c.file))))!.samples
      const out = await arms[j.a](wavOf(variants[j.v](pcm)))
      const s = align(j.c.ref, out.text)
      t.n += s.refWords; t.d += s.deletions; t.e += s.errors
      if (j.a.startsWith('gateway')) roles.set(`${j.v} ${j.a}: ${out.role}`, (roles.get(`${j.v} ${j.a}: ${out.role}`) ?? 0) + 1)
      if (s.deletions > s.refWords * 0.25) worst.push(`- ${key}: lost ${s.deletions}/${s.refWords} — «${out.text}»`)
    } catch { t.fail++ }
  }
}))
let md = `## Quiet and muffled speech (${clips.length} clips × ${runs})\n\n| audio | arm | WER | deleted / 100 ref | failed |\n|---|---|---|---|---|\n`
for (const [k, t] of tot) { const [v, a] = k.split(' | '); md += `| ${v} | ${a} | ${t.n ? ((100 * t.e) / t.n).toFixed(1) : '-'}% | ${t.n ? ((100 * t.d) / t.n).toFixed(1) : '-'} | ${t.fail} |\n` }
md += `\n### Which model answered (gateway)\n\n${[...roles].map(([k, n]) => `${k} ×${n}`).join(' · ')}\n\n### Answers that lost over a quarter of the words\n\n${worst.slice(0, 40).join('\n') || 'none'}\n`
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
