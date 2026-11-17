/**
 * Long dictations the way the desktop streams them: utterances in a row stand for the pieces cut at
 * pauses. Each piece goes through the gateway (background tier) with the end of the piece before as
 * a carry prompt, is formatted with that end as the preceding text, has a copied echo stripped, and
 * the pieces are joined with joinPieces. WER is scored after each stage, so a stage that loses words
 * shows up on its own.  npx tsx eval/pieces.ts /tmp/stt-eval [runs=2]
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { handleFormat, handleTranscriptions, type GatewayHooks } from '../../../packages/backend/convex/lib/gatewayCore'
import { STT_BASE_PROMPT } from '../../../packages/text-engine/src/dictionary'
import { joinPieces, rawSeamContinues, seamContext, stripEcho } from '../../../packages/text-engine/src/seam'
import { align } from './score'

const dir = resolve(process.argv[2] ?? '/tmp/stt-eval')
const runs = Number(process.argv[3] ?? 2)
const raw = readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8')
const vars = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as { vars: Record<string, string> }).vars
const env: Record<string, string> = { ...vars, MURMUR_INFERENCE_STT_KEY: process.env.MURMUR_INFERENCE_STT_KEY ?? '', MURMUR_INFERENCE_LLM_KEY: process.env.MURMUR_INFERENCE_LLM_KEY ?? '' }
const identity = { subject: 'stt-eval' }
const hooks = {
  env,
  access: async () => 'active',
  authorize: async () => ({ ok: true, userId: 'stt-eval', plan: 'free', planState: 'active', paused: null, provider: { failures: 0, openForSec: null } }),
  record: async () => {},
  providerFailed: async () => ({ failures: 0, openForSec: null }),
  providerRecovered: async () => {}
} as unknown as GatewayHooks
const PIECE_NOTE = 'This transcript is one part of a longer dictation and may stop mid-sentence; if it does, leave the end unpunctuated.'

async function stt(wav: Uint8Array, prompt: string, tier: string) {
  const f = new FormData()
  f.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  const fields: Record<string, string> = { model: 'murmur-transcribe', response_format: 'verbose_json', temperature: '0', speed: 'normal', prompt }
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  f.append('timestamp_granularities[]', 'word'); f.append('timestamp_granularities[]', 'segment')
  const res = await handleTranscriptions(hooks, identity, new Request('https://eval.local/v1/audio/transcriptions', { method: 'POST', headers: { 'x-murmur-tier': tier }, body: f }))
  const body = await res.text()
  if (!res.ok) throw new Error(`stt ${res.status} ${body.slice(0, 150)}`)
  return ((JSON.parse(body) as { text?: string }).text ?? '').trim()
}
async function fmt(transcript: string, precedingText: string | undefined, last: boolean) {
  const context: Record<string, unknown> = { category: 'unknown', ...(precedingText ? { precedingText } : {}), ...(last ? {} : { instructions: PIECE_NOTE }) }
  const res = await handleFormat(hooks, identity, new Request('https://eval.local/v1/format', { method: 'POST', headers: { 'content-type': 'application/json', 'x-murmur-tier': 'background' }, body: JSON.stringify({ transcript, context }) }))
  const b = (await res.json()) as { text?: string; status?: { outcome?: string } }
  return { text: b.text ?? transcript, outcome: b.status?.outcome }
}

const clips = (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id: string; file: string; ref: string; kind: string }[]).filter((c) => c.kind.startsWith('test-'))
const groups: (typeof clips)[] = []
for (let i = 0; i + 3 <= clips.length; i += 3) groups.push(clips.slice(i, i + 3))
const stages = ['pieces raw', 'pieces raw joined', 'pieces formatted', 'formatted + stripEcho joined', 'whole raw', 'whole formatted'] as const
const tot: Record<string, { e: number; n: number; d: number }> = Object.fromEntries(stages.map((s) => [s, { e: 0, n: 0, d: 0 }]))
const worst: string[] = []
const add = (s: string, ref: string, hyp: string) => { const a = align(ref, hyp); tot[s].e += a.errors; tot[s].n += a.refWords; tot[s].d += a.deletions; return a }
await Promise.all(groups.map(async (g, gi) => {
  for (let r = 0; r < runs; r++) {
    const ref = g.map((c) => c.ref).join(' ')
    const wavs = g.map((c) => new Uint8Array(readFileSync(join(dir, c.file))))
    const rawT: string[] = []
    for (let i = 0; i < wavs.length; i++) {
      const carry = i > 0 ? seamContext(rawT[i - 1]) : ''
      rawT.push(await stt(wavs[i], carry ? `${STT_BASE_PROMPT} ${carry}` : STT_BASE_PROMPT, i === wavs.length - 1 ? 'release' : 'background'))
    }
    g.forEach((c, i) => add('pieces raw', c.ref, rawT[i]))
    const joinedRaw = joinPieces(rawT)
    add('pieces raw joined', ref, joinedRaw.text)
    const fm = await Promise.all(rawT.map((t, i) => fmt(t, i > 0 ? seamContext(rawT[i - 1]) : undefined, i === rawT.length - 1)))
    g.forEach((c, i) => add('pieces formatted', c.ref, fm[i].text))
    const stripped = fm.map((f, i) => (i > 0 ? stripEcho(f.text, seamContext(rawT[i - 1])) : f.text))
    const cont = rawT.map((t, i) => (i + 1 < rawT.length ? rawSeamContinues(t, rawT[i + 1]) : false))
    const final = joinPieces(stripped, cont).text
    const a = add('formatted + stripEcho joined', ref, final)
    // The same audio as one clip.
    const pcm = wavs.map((w) => w.subarray(44))
    const len = pcm.reduce((s, p) => s + p.length, 0)
    const whole = new Uint8Array(44 + len); whole.set(wavs[0].subarray(0, 44)); let o = 44; for (const p of pcm) { whole.set(p, o); o += p.length }
    const dv = new DataView(whole.buffer); dv.setUint32(4, 36 + len, true); dv.setUint32(40, len, true)
    const w = await stt(whole, STT_BASE_PROMPT, 'release')
    add('whole raw', ref, w)
    add('whole formatted', ref, (await fmt(w, undefined, true)).text)
    if (a.deletions > 2) worst.push(`- group ${gi} run ${r}: ${a.deletions} words lost (dedupe ${joinedRaw.deduped})\n  - ref: ${ref}\n  - raw pieces: ${rawT.map((t) => `«${t}»`).join(' ')}\n  - formatted: ${fm.map((f) => `«${f.text}» (${f.outcome})`).join(' ')}\n  - final: ${final}`)
  }
}))
let md = `## Streamed pieces (${groups.length} dictations of 3 pieces, ${runs} runs)\n\n| stage | WER | deleted / 100 ref |\n|---|---|---|\n`
for (const s of stages) md += `| ${s} | ${((100 * tot[s].e) / tot[s].n).toFixed(1)}% | ${((100 * tot[s].d) / tot[s].n).toFixed(2)} |\n`
md += `\n### Dictations that lost words\n\n${worst.join('\n') || 'none'}\n`
console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
