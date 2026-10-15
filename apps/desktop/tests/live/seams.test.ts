import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { DEFAULT_CHUNK_PLAN, findCutDetail, type ChunkPlan } from '@core/audio/chunker'
import { adaptiveThreshold } from '@core/audio/vad'
import { encodeWavPcm16 } from '@core/audio/wav'
import {
  formatTranscript,
  joinPieces,
  seamContext,
  stripEcho,
  type ChatMessage,
  type ChatOptions,
  type ChatResult
} from '@engine'
import type { FormatContext } from '@engine'
import { FORCED_OVERLAP_SEC, PAUSE_LEAD_IN_SEC } from '../../src/main/dictation/streaming'

/**
 * Seam regression eval for streamed precision dictation: long recordings with natural pauses,
 * cut the way the streamer cuts them, each piece transcribed and formatted, joined as the session
 * joins them. Compares v0.6.16 (15-28 s pieces at 300 ms pauses, plain joins, pieces formatted
 * blind) with the current pipeline.
 *
 *   MURMUR_LIVE=1 MURMUR_SEAM_META=meta.json MURMUR_BASE_URL=... MURMUR_API_KEY=... \
 *   MURMUR_STT_MODEL=transcribe-1 MURMUR_LLM_MODEL=complete [MURMUR_REASONING=low] \
 *   [MURMUR_SEAM_OUT=results.jsonl] [MURMUR_SEAM_RUNS=1] npx vitest run tests/live/seams.test.ts
 *
 * meta.json: { name: { wav, ref, kind: 'tts' | 'real' } }; an empty ref is the whole clip transcribed
 * in one request (cached next to the WAV). A sentence break the output puts at a seam where the
 * reference has none is counted: for 'tts' the reference is the script, for 'real' speech the
 * one-request transcript, punctuated with the whole recording as context.
 *
 * Seam error: within two reference words either side of a seam, a word lost, doubled or changed,
 * or (tts) a sentence break that the reference does not have.
 */
const metaFile = process.env.MURMUR_SEAM_META ?? ''
const baseUrl = (process.env.MURMUR_BASE_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.MURMUR_API_KEY ?? ''
const sttModel = process.env.MURMUR_STT_MODEL ?? 'transcribe-1'
const llmModel = process.env.MURMUR_LLM_MODEL ?? 'complete'
const out = process.env.MURMUR_SEAM_OUT
const runs = Number(process.env.MURMUR_SEAM_RUNS ?? 1)
const only = process.env.MURMUR_SEAM_ONLY // clip/pipeline filter, a regex
const dump = process.env.MURMUR_SEAM_DUMP // a file to append every piece's texts to
const RATE = 16000

const OLD_PLAN: ChunkPlan = { minSec: 15, maxSec: 28, pauseMs: 300, fallbackPauseMs: Infinity }
const PIECE_NOTE =
  'This transcript is one part of a longer dictation and may stop mid-sentence; if it does, leave the end unpunctuated.'

function readWav(path: string): Int16Array {
  const buf = readFileSync(path)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const bytes = buf.subarray(off + 8, off + 8 + size)
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
    }
    off += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}

async function retry<T>(f: () => Promise<T>, n = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (i >= n) throw e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
}

async function stt(pcm: Int16Array): Promise<string> {
  return retry(async () => {
    const form = new FormData()
    form.append('model', sttModel)
    form.append('response_format', 'json')
    form.append('file', new Blob([encodeWavPcm16(pcm, RATE)], { type: 'audio/wav' }), 'a.wav')
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    })
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`)
    return (((await res.json()) as { text?: string }).text ?? '').trim()
  })
}

async function complete(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
  return retry(async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: llmModel,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 1024,
        ...(process.env.MURMUR_REASONING ? { reasoning_effort: process.env.MURMUR_REASONING } : {}),
        stream: false
      })
    })
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
    }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      finishReason: json.choices?.[0]?.finish_reason
    }
  })
}

const CTX: FormatContext = {
  category: 'document',
  tone: 'professional',
  dictionary: [],
  language: 'auto'
}

async function format(text: string, before: string, note: boolean): Promise<string> {
  if (!text.trim()) return ''
  const prior = seamContext(before)
  const context: FormatContext = {
    ...CTX,
    precedingText: prior || undefined,
    instructions: note ? PIECE_NOTE : undefined
  }
  const r = await formatTranscript({ transcript: text, mode: 'smart', context }, complete)
  return prior ? stripEcho(r.text, prior) : r.text
}

/** Pieces as the streamer would send them, and where the tail starts. */
function cutPieces(
  pcm: Int16Array,
  plan: ChunkPlan,
  overlap: boolean
): { pieces: Int16Array[]; tailFrom: number } {
  const pieces: Int16Array[] = []
  let committed = 0
  let lead = 0
  for (;;) {
    const window = pcm.subarray(
      committed,
      Math.min(pcm.length, committed + Math.ceil((plan.maxSec + 0.5) * RATE))
    )
    const threshold = adaptiveThreshold(window, RATE, -48)
    const cut = findCutDetail(window, RATE, threshold, plan)
    if (!cut || committed + cut.at >= pcm.length - RATE) break
    pieces.push(pcm.slice(committed - lead, committed + cut.at))
    committed += cut.at
    lead = !overlap
      ? 0
      : Math.min(
          cut.at,
          Math.floor(
            (cut.forced
              ? FORCED_OVERLAP_SEC
              : Math.min(PAUSE_LEAD_IN_SEC, Math.max(0, cut.pauseMs / 2000 - 0.05))) * RATE
          )
        )
  }
  return { pieces, tailFrom: committed - lead }
}

const NUMBERISH =
  /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|percent|dollars?|o'clock|\d.*)$/

interface Tok {
  w: string
  end: boolean
}
function toks(s: string): Tok[] {
  const out: Tok[] = []
  for (const m of s.matchAll(/([\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)([^\p{L}\p{N}]*)/gu))
    out.push({ w: m[1].toLowerCase().replace(/’/g, "'"), end: /[.!?…]/.test(m[2]) })
  return out
}
const norm = (s: string): string[] => toks(s.replace(/-/g, ' ')).map((t) => t.w)

/** Edit-distance alignment: for each ref index, the hyp index it maps to (or -1), and the ops. */
function align(
  ref: string[],
  hyp: string[]
): { ops: Array<'=' | 'S' | 'D' | 'I'>; r: number[]; h: number[]; dist: number } {
  const n = ref.length
  const m = hyp.length
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      )
  const ops: Array<'=' | 'S' | 'D' | 'I'> = []
  const r: number[] = []
  const h: number[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push(ref[i - 1] === hyp[j - 1] ? '=' : 'S')
      r.push(i - 1)
      h.push(j - 1)
      i--
      j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push('D')
      r.push(i - 1)
      h.push(j)
      i--
    } else {
      ops.push('I')
      r.push(i)
      h.push(j - 1)
      j--
    }
  }
  return { ops: ops.reverse(), r: r.reverse(), h: h.reverse(), dist: d[n][m] }
}

const wer = (ref: string, hyp: string): number => {
  const r = norm(ref)
  return align(r, norm(hyp)).dist / Math.max(1, r.length)
}

/** Seam errors in `text` given the hyp word index where each seam falls. */
function seamErrors(
  ref: string,
  text: string,
  seams: number[],
  punctuated: boolean
): { seams: number; word: number; brk: number; errors: number; examples: string[] } {
  const rt = toks(ref.replace(/-/g, ' '))
  const ht = toks(text.replace(/-/g, ' '))
  const a = align(
    rt.map((t) => t.w),
    ht.map((t) => t.w)
  )
  let word = 0
  let brk = 0
  let errors = 0
  const examples: string[] = []
  for (const s of seams) {
    // The ref position of the first hyp word after the seam.
    let k = a.h.findIndex((hh, idx) => hh >= s && a.ops[idx] !== 'D')
    if (k < 0) k = a.ops.length - 1
    const rpos = a.r[k]
    let bad = false
    for (let idx = 0; idx < a.ops.length; idx++) {
      if (a.r[idx] < rpos - 2 || a.r[idx] > rpos + 1 || a.ops[idx] === '=') continue
      // "four percent" written "4%": formatting, not a seam error.
      const op = a.ops[idx]
      const refWord = op === 'I' ? '' : (rt[a.r[idx]]?.w ?? '')
      const hypWord = op === 'D' ? '' : (ht[a.h[idx]]?.w ?? '')
      if (NUMBERISH.test(refWord) || /\d/.test(hypWord)) continue
      bad = true
    }
    let breakBad = false
    if (punctuated && s > 0 && ht[s - 1]?.end) {
      const prevRef = rpos - 1
      if (prevRef >= 0 && !rt[prevRef].end) breakBad = true
    }
    if (bad || breakBad) errors++
    if (bad) word++
    if (breakBad) brk++
    if ((bad || breakBad) && examples.length < 6) {
      examples.push(
        `…${ht
          .slice(Math.max(0, s - 4), s + 4)
          .map((t, i) => t.w + (t.end ? '.' : '') + (i === Math.min(4, s) - 1 ? ' |' : ''))
          .join(' ')}…`
      )
    }
  }
  return { seams: seams.length, word, brk, errors, examples }
}

/** Hyp word index of each seam for a list of parts joined with `join`. */
function seamIndex(parts: string[], join: (p: string[]) => string): number[] {
  const out: number[] = []
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].trim()) continue
    out.push(toks(join(parts.slice(0, i))).length)
  }
  return out
}

const plain = (p: string[]): string =>
  p
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ')
const seamed = (p: string[]): string => joinPieces(p).text

async function pool<T, R>(items: T[], n: number, f: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        res[i] = await f(items[i], i)
      }
    })
  )
  return res
}

/** Seam and word scores of one run's pieces. */
function score(
  ref: string,
  kind: string,
  sttParts: string[],
  finalParts: string[],
  join: (p: string[]) => string
): {
  seams: number
  seamErrFinal: number
  seamWordErrFinal: number
  seamBreakErrFinal: number
  seamErrStt: number
  werStt: number
  werFinal: number
  examples: string[]
} {
  const sttText = join(sttParts)
  const finalText = join(finalParts)
  // The tts reference is the script; for real speech it is the one-request transcript, whose
  // punctuation was decided with the whole recording as context.
  const punct = kind === 'tts' || kind === 'real'
  const sSeams = seamErrors(ref, sttText, seamIndex(sttParts, join), punct)
  const fSeams = seamErrors(ref, finalText, seamIndex(finalParts, join), punct)
  return {
    seams: fSeams.seams,
    seamErrFinal: fSeams.errors,
    seamWordErrFinal: fSeams.word,
    seamBreakErrFinal: fSeams.brk,
    seamErrStt: sSeams.errors,
    werStt: +wer(ref, sttText).toFixed(4),
    werFinal: +wer(ref, finalText).toFixed(4),
    examples: fSeams.examples
  }
}

/** MURMUR_SEAM_RESCORE=dump.jsonl: score a previous run's texts again, no requests. */
const rescore = process.env.MURMUR_SEAM_RESCORE
describe.skipIf(!rescore)('seam rescore', () => {
  it('rescores', () => {
    for (const line of readFileSync(rescore!, 'utf8').split('\n').filter(Boolean)) {
      const d = JSON.parse(line)
      const join = d.pipeline === 'seam-aware' ? seamed : plain
      const row = { ...d.row, ...score(d.ref, d.kind, d.sttParts, d.finalParts, join) }
      console.log(JSON.stringify(row))
      if (out) appendFileSync(out, JSON.stringify(row) + '\n')
    }
  })
})

describe.skipIf(!metaFile || !baseUrl)('seam eval', () => {
  const meta = metaFile
    ? (JSON.parse(readFileSync(metaFile, 'utf8')) as Record<
        string,
        { wav: string; ref: string; kind: string }
      >)
    : {}
  for (const [name, m] of Object.entries(meta)) {
    for (const pipeline of ['v0.6.16', 'seam-aware'] as const) {
      it.skipIf(only !== undefined && !new RegExp(only).test(`${name} ${pipeline}`))(
        `${name} ${pipeline}`,
        { timeout: 900_000 },
        async () => {
          const pcm = readWav(m.wav)
          // Real speech has no written reference: the whole clip transcribed in one request (no
          // seams at all) stands in, so the score is what the seams change.
          if (!m.ref) {
            const cache = `${m.wav}.ref.txt`
            m.ref = existsSync(cache) ? readFileSync(cache, 'utf8') : await stt(pcm)
            writeFileSync(cache, m.ref)
          }
          const isNew = pipeline === 'seam-aware'
          const { pieces, tailFrom } = cutPieces(pcm, isNew ? DEFAULT_CHUNK_PLAN : OLD_PLAN, isNew)
          const join = isNew ? seamed : plain
          for (let run = 0; run < runs; run++) {
            const texts = await pool(pieces, 3, (p) => stt(p))
            const formatted = await pool(texts, 3, (t, i) =>
              format(t, isNew && i > 0 ? texts[i - 1] : '', isNew)
            )
            const tail = pcm.subarray(tailFrom)
            const t0 = performance.now()
            const tailText = await stt(tail)
            const sttMs = performance.now() - t0
            const tailFormatted = await format(
              tailText,
              isNew ? (texts[texts.length - 1] ?? '') : '',
              false
            )
            const releaseMs = performance.now() - t0
            const sttParts = [...texts, tailText]
            const finalParts = [...formatted, tailFormatted]
            const row = {
              clip: name,
              kind: m.kind,
              pipeline,
              run,
              durSec: Math.round(pcm.length / RATE),
              pieces: pieces.length + 1,
              tailSec: +(tail.length / RATE).toFixed(1),
              tailSttMs: Math.round(sttMs),
              releaseMs: Math.round(releaseMs),
              ...score(m.ref, m.kind, sttParts, finalParts, join)
            }
            if (dump)
              appendFileSync(
                dump,
                JSON.stringify({
                  clip: name,
                  kind: m.kind,
                  pipeline,
                  run,
                  ref: m.ref,
                  sttParts,
                  finalParts,
                  row
                }) + '\n'
              )
            console.log(JSON.stringify(row))
            if (out) appendFileSync(out, JSON.stringify(row) + '\n')
          }
        }
      )
    }
  }
})
