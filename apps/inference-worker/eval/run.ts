/**
 * Transcription eval through the real hosted path: every clip from prepare-audio.sh goes through
 * the Worker's own handleTranscriptions (gatewayCore) against the production provider, with the
 * production model settings from wrangler.jsonc, then through handleFormat (the cleanup step).
 * Sign-in and allowance are stubbed the way the Worker's tests stub them, so no Clerk session is
 * needed; the provider keys come from the environment (the Worker's own Actions secrets).
 *
 *   MURMUR_INFERENCE_STT_KEY=... MURMUR_INFERENCE_LLM_KEY=... \
 *     npx tsx eval/run.ts /tmp/stt-eval [runs=5] [tag]
 *
 * Each clip runs `runs` times per arm. Arms: the gateway release (what a user waits on), each
 * upstream model on its own (to find which one adds words), and a carry-over prompt (the end of
 * the previous piece, as the desktop sends on seams). Writes <dir>/result-<tag>.json and prints a
 * markdown report (also appended to $GITHUB_STEP_SUMMARY).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { handleFormat, handleTranscriptions, type GatewayHooks } from '../../../packages/backend/convex/lib/gatewayCore'
import { STT_BASE_PROMPT } from '../../../packages/text-engine/src/dictionary'
import { align, normalize, type Alignment } from './score'

interface Clip {
  id: string
  file: string
  ref: string
  kind: string
  loose?: boolean
}

const dir = resolve(process.argv[2] ?? '/tmp/stt-eval')
const runs = Number(process.argv[3] ?? 5)
const tag = process.argv[4] ?? 'run'
const only = process.env.STT_EVAL_ARMS?.split(',')
const concurrency = Number(process.env.STT_EVAL_CONCURRENCY ?? 3)

function wranglerVars(): Record<string, string> {
  const raw = readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8')
  const json = raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')
  return (JSON.parse(json) as { vars: Record<string, string> }).vars
}
const env: Record<string, string> = {
  ...wranglerVars(),
  MURMUR_INFERENCE_STT_KEY: process.env.MURMUR_INFERENCE_STT_KEY ?? '',
  MURMUR_INFERENCE_LLM_KEY: process.env.MURMUR_INFERENCE_LLM_KEY ?? ''
}
for (const [k, v] of Object.entries(process.env)) if (k.startsWith('STT_EVAL_ENV_') && v) env[k.slice(13)] = v
if (!env.MURMUR_INFERENCE_STT_KEY) throw new Error('MURMUR_INFERENCE_STT_KEY is not set')

const identity = { subject: 'stt-eval' }
const hooks: GatewayHooks = {
  env,
  access: async () => 'active',
  authorize: async () => ({
    ok: true,
    userId: 'stt-eval',
    plan: 'free',
    planState: 'active',
    paused: null,
    provider: { failures: 0, openForSec: null }
  }),
  record: async () => {},
  providerFailed: async () => ({ failures: 0, openForSec: null }),
  providerRecovered: async () => {}
} as unknown as GatewayHooks

interface Arm {
  name: string
  run(wav: Uint8Array, clip: Clip): Promise<{ text: string; ms: number; role?: string; hedged?: boolean }>
}

function form(wav: Uint8Array, fields: Record<string, string | string[]>): FormData {
  const f = new FormData()
  f.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x)
  return f
}

/** The desktop/Android release request, through the Worker's handler. */
async function gateway(wav: Uint8Array, prompt: string | undefined, tier = 'release') {
  const started = performance.now()
  const req = new Request('https://eval.local/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'x-murmur-tier': tier },
    body: form(wav, {
      model: 'murmur-transcribe',
      response_format: 'verbose_json',
      temperature: '0',
      'timestamp_granularities[]': ['word', 'segment'],
      speed: 'normal',
      ...(prompt ? { prompt } : {})
    })
  })
  const res = await handleTranscriptions(hooks, identity, req)
  const body = await res.text()
  const ms = performance.now() - started
  if (!res.ok) throw new Error(`gateway ${res.status}: ${body.slice(0, 200)}`)
  const trace = JSON.parse(res.headers.get('x-murmur-trace') ?? '{}') as { role?: string; hedged?: boolean }
  return { text: (JSON.parse(body) as { text?: string }).text ?? '', ms, role: trace.role, hedged: trace.hedged }
}

/** One upstream model on its own, the way the gateway asks it (no hedge, no clean-up). */
async function direct(wav: Uint8Array, model: string, prompt: string | undefined, plain: boolean) {
  const started = performance.now()
  const res = await fetch(`${env.MURMUR_INFERENCE_STT_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MURMUR_INFERENCE_STT_KEY}` },
    body: form(wav, {
      model,
      response_format: plain ? 'json' : 'verbose_json',
      temperature: '0',
      ...(plain ? {} : { 'timestamp_granularities[]': ['word', 'segment'] }),
      ...(prompt ? { prompt } : {})
    }),
    signal: AbortSignal.timeout(30_000)
  })
  const body = await res.text()
  const ms = performance.now() - started
  if (!res.ok) throw new Error(`${model} ${res.status}: ${body.slice(0, 200)}`)
  return { text: (JSON.parse(body) as { text?: string }).text ?? '', ms, role: model }
}

const CARRY = 'and that is what I wanted to say about it'
const arms: Arm[] = [
  { name: 'gateway', run: (w) => gateway(w, STT_BASE_PROMPT) },
  { name: 'gateway-carry', run: (w) => gateway(w, `${STT_BASE_PROMPT} ${CARRY}`) },
  { name: 'gateway-bg', run: (w) => gateway(w, STT_BASE_PROMPT, 'background') },
  { name: `fast:${env.MURMUR_INFERENCE_STT_FAST_MODEL}`, run: (w) => direct(w, env.MURMUR_INFERENCE_STT_FAST_MODEL!, STT_BASE_PROMPT, false) },
  { name: `fast-noprompt`, run: (w) => direct(w, env.MURMUR_INFERENCE_STT_FAST_MODEL!, undefined, false) },
  { name: `normal:${env.MURMUR_INFERENCE_STT_MODEL}`, run: (w) => direct(w, env.MURMUR_INFERENCE_STT_MODEL!, STT_BASE_PROMPT, false) },
  { name: `hedge:${env.MURMUR_INFERENCE_STT_HEDGE_MODEL}`, run: (w) => direct(w, env.MURMUR_INFERENCE_STT_HEDGE_MODEL!, STT_BASE_PROMPT, true) }
].filter((a) => !only || only.some((o) => a.name.startsWith(o)))

/** The cleanup step on the gateway's own answer, as a release sends it. */
async function format(transcript: string) {
  const started = performance.now()
  const req = new Request('https://eval.local/v1/format', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-murmur-tier': 'release' },
    body: JSON.stringify({ transcript, context: { category: 'unknown' } })
  })
  const res = await handleFormat(hooks, identity, req)
  const body = (await res.json()) as { text?: string; status?: { outcome?: string } }
  return { text: body.text ?? transcript, ms: performance.now() - started, outcome: body.status?.outcome }
}

interface Row {
  clip: string
  kind: string
  arm: string
  run: number
  text?: string
  error?: string
  ms?: number
  role?: string
  hedged?: boolean
  score?: Alignment
  formatted?: { text: string; ms: number; outcome?: string; score: Alignment }
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items]
  await Promise.all(Array.from({ length: n }, async () => { for (let t = q.shift(); t !== undefined; t = q.shift()) await fn(t) }))
}

const clips = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Clip[]
const rows: Row[] = []
const jobs = clips.flatMap((c) => arms.flatMap((a) => Array.from({ length: runs }, (_, r) => ({ c, a, r }))))
let done = 0
await pool(jobs, concurrency, async ({ c, a, r }) => {
  const wav = new Uint8Array(readFileSync(join(dir, c.file)))
  const row: Row = { clip: c.id, kind: c.kind, arm: a.name, run: r }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await a.run(wav, c)
      Object.assign(row, out, { error: undefined, score: align(c.ref, out.text, c.loose) })
      if (a.name === 'gateway' && out.text.trim()) {
        const f = await format(out.text)
        row.formatted = { ...f, score: align(c.ref, f.text, c.loose) }
      }
      break
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err)
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  rows.push(row)
  if (++done % 25 === 0) console.error(`${done}/${jobs.length}`)
})

writeFileSync(join(dir, `result-${tag}.json`), JSON.stringify({ tag, runs, env: { ...env, MURMUR_INFERENCE_STT_KEY: undefined, MURMUR_INFERENCE_LLM_KEY: undefined }, rows }, null, 1))

// ---- report
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const lines: string[] = [`## Transcription eval: ${tag} (${runs} runs per clip per arm, ${clips.length} clips)`, '']
lines.push('| arm | WER | inserted words / 100 ref | words on no-speech clips | clips whose text varies across runs | p50 ms | p90 ms | errors |', '|---|---|---|---|---|---|---|---|')
const summarize = (name: string, rs: Row[], pick: (r: Row) => { text: string; ms: number; score: Alignment } | undefined) => {
  const ok = rs.filter((r) => pick(r))
  const speech = ok.filter((r) => r.kind !== 'no-speech')
  const ref = speech.reduce((s, r) => s + pick(r)!.score.refWords, 0)
  const errs = speech.reduce((s, r) => s + pick(r)!.score.errors, 0)
  const ins = speech.reduce((s, r) => s + pick(r)!.score.insertions, 0)
  const none = ok.filter((r) => r.kind === 'no-speech').reduce((s, r) => s + pick(r)!.score.hypWords, 0)
  const byClip = new Map<string, Set<string>>()
  for (const r of ok) (byClip.get(r.clip) ?? byClip.set(r.clip, new Set()).get(r.clip)!).add(normalize(pick(r)!.text).join(' '))
  const varying = [...byClip.values()].filter((s) => s.size > 1).length
  const ms = ok.map((r) => pick(r)!.ms)
  lines.push(`| ${name} | ${pct(errs / Math.max(1, ref))} | ${(100 * ins / Math.max(1, ref)).toFixed(2)} | ${none} | ${varying}/${byClip.size} | ${Math.round(q(ms, 0.5))} | ${Math.round(q(ms, 0.9))} | ${rs.length - ok.length} |`)
}
for (const a of arms) {
  const rs = rows.filter((r) => r.arm === a.name)
  summarize(a.name, rs, (r) => (r.score && r.text !== undefined ? { text: r.text, ms: r.ms!, score: r.score } : undefined))
  if (a.name === 'gateway')
    summarize('gateway + cleanup (format stage only ms)', rs, (r) => r.formatted ?? (r.score && r.text !== undefined && !r.text.trim() ? { text: '', ms: 0, score: r.score } : undefined))
}
lines.push('', '### By kind (gateway release, then after cleanup)', '', '| kind | WER | inserted / 100 | WER after cleanup | inserted after cleanup |', '|---|---|---|---|---|')
for (const kind of [...new Set(clips.map((c) => c.kind))]) {
  const rs = rows.filter((r) => r.arm === 'gateway' && r.kind === kind && r.score)
  const ref = rs.reduce((s, r) => s + r.score!.refWords, 0)
  const f = rs.filter((r) => r.formatted)
  const fr = f.reduce((s, r) => s + r.formatted!.score.refWords, 0)
  const sum = (xs: Row[], k: (r: Row) => number) => xs.reduce((s, r) => s + k(r), 0)
  lines.push(kind === 'no-speech'
    ? `| ${kind} | words: ${sum(rs, (r) => r.score!.hypWords)} | | words: ${sum(f, (r) => r.formatted!.score.hypWords)} | |`
    : `| ${kind} | ${pct(sum(rs, (r) => r.score!.errors) / Math.max(1, ref))} | ${(100 * sum(rs, (r) => r.score!.insertions) / Math.max(1, ref)).toFixed(2)} | ${pct(sum(f, (r) => r.formatted!.score.errors) / Math.max(1, fr))} | ${(100 * sum(f, (r) => r.formatted!.score.insertions) / Math.max(1, fr)).toFixed(2)} |`)
}
lines.push('', '### Inserted words (gateway, gateway-carry, cleanup), most frequent', '')
const inserted = new Map<string, number>()
for (const r of rows) {
  if (r.arm.startsWith('gateway') && r.arm !== 'gateway-bg') for (const w of r.score?.inserted ?? []) inserted.set(`${r.arm}: ${w}`, (inserted.get(`${r.arm}: ${w}`) ?? 0) + 1)
  for (const w of r.formatted?.score.inserted ?? []) inserted.set(`cleanup: ${w}`, (inserted.get(`cleanup: ${w}`) ?? 0) + 1)
}
lines.push([...inserted].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([w, n]) => `${w} ×${n}`).join(' · ') || 'none')
lines.push('', '### No-speech answers (any arm)', '')
for (const r of rows.filter((r) => r.kind === 'no-speech' && r.text?.trim())) lines.push(`- ${r.arm} ${r.clip} #${r.run}: “${r.text!.trim()}”`)
lines.push('', '### Hedge winners (gateway release)', '')
const roles = new Map<string, number>()
for (const r of rows.filter((r) => r.arm === 'gateway' && r.role)) roles.set(`${r.role}${r.hedged ? ' (hedged)' : ''}`, (roles.get(`${r.role}${r.hedged ? ' (hedged)' : ''}`) ?? 0) + 1)
lines.push([...roles].map(([k, n]) => `${k}: ${n}`).join(', '))
const errors = rows.filter((r) => r.error).slice(0, 10)
if (errors.length) lines.push('', '### Errors (first 10)', '', ...errors.map((r) => `- ${r.arm} ${r.clip}: ${r.error}`))
const report = lines.join('\n')
console.log(report)
writeFileSync(join(dir, `report-${tag}.md`), report)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n')
