import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoTone } from '../src/context'
import { formatTranscript } from '../src/format'
import { layoutText } from '../src/layout'
import { isNumberWord } from '../src/numbers'
import { applyCasing, profileOf } from '../src/profiles'
import type { AppCategory, ChatMessage, ChatOptions, ChatResult, FormatContext } from '../src/types'

/**
 * Profiles against a real model: each dictation formatted the way the desktop app finishes it
 * with that profile (the one formatting request, the layout pass when the text is long enough,
 * casing on the device), then checked for layout and fidelity:
 *
 *   - lists: a dictated enumeration comes out one item per line (numbered when counted);
 *   - paragraphs: the number of blank-line paragraphs is in range (none in chat or "As spoken");
 *   - split sentences: a sentence the recognizer cut at a pause ("at least. A minute") is joined;
 *   - endings: the last words the speaker said are there;
 *   - invented words: words in the answer that were never said (digits aside);
 *   - kept wording: "As spoken" keeps the speaker's grammar.
 *
 *   MURMUR_LIVE=1 MURMUR_BASE_URL=... MURMUR_API_KEY=... MURMUR_LLM_MODEL=... \
 *   npx vitest run eval/profiles-live.test.ts
 *
 * Optional: MURMUR_PROFILE_RUNS (repeats of the corpus, default 1). Writes
 * eval/last-profiles-live.json with every answer and check.
 */

const baseUrl = process.env.MURMUR_BASE_URL ?? ''
const apiKey = process.env.MURMUR_API_KEY ?? ''
const model = process.env.MURMUR_LLM_MODEL ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!baseUrl && !!model
const RUNS = Number(process.env.MURMUR_PROFILE_RUNS ?? '1')
/** Pause between requests, for providers that rate-limit bursts (default 0). */
const DELAY_MS = Number(process.env.MURMUR_EVAL_DELAY_MS ?? '0')

interface ProfileFixture {
  id: string
  profile: string
  category: AppCategory
  transcript: string
  expect: {
    list: 'ordered' | 'any' | 'none'
    items?: number
    /** An inline series ("eggs, milk and rice") is as good as a list here. */
    inline_ok?: boolean
    paragraphs?: [number, number]
    /** Regex (case-insensitive) the last 80 characters must match. */
    end: string
    /** Regexes for sentences wrongly split at a pause; none may remain. */
    split?: string[]
    /** Phrases that must survive (case-insensitive). */
    keep?: string[]
  }
}

export function loadProfileFixtures(): ProfileFixture[] {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'profiles.json'), 'utf8')
  ) as ProfileFixture[]
}

const LIST_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/
const NUMBERED_LINE = /^\s*\d{1,2}[.)]\s+\S/

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)

/** Words in `out` the speaker never said (numbers and list cues aside). */
export function inventedWords(transcript: string, out: string): string[] {
  // "and" joining two sentences the speaker said is punctuation, not content.
  const said = new Set([...words(transcript), 'and'])
  // Forms a contraction or a number may take on either side.
  for (const w of [...said]) {
    for (const part of w.split("'")) said.add(part)
    said.add(w.replace(/'s$/, ''))
  }
  return words(out).filter((w) => {
    if (said.has(w) || /\d/.test(w)) return false
    if (said.has(w.replace(/'s$/, '')) || said.has(`${w}s`) || said.has(w.replace(/s$/, '')))
      return false
    return !w.split("'").every((p) => said.has(p))
  })
}

/** Said but not typed: fillers, list cues and numbers (written as digits) aside. */
const MAY_GO = new Set(
  'um uh so like okay ok well yeah you know i mean and also then first second third fourth fifth firstly secondly thirdly finally lastly number item percent dollars dollar or'.split(
    ' '
  )
)

/** Words the speaker said that are missing from `out`. */
export function lostWords(transcript: string, out: string): string[] {
  const typed = new Set(words(out))
  for (const w of [...typed]) for (const part of w.split("'")) typed.add(part)
  return words(transcript).filter((w) => {
    if (typed.has(w) || MAY_GO.has(w) || isNumberWord(w) || /\d/.test(w)) return false
    if (typed.has(w.replace(/'s$/, '')) || typed.has(`${w}s`) || typed.has(w.replace(/s$/, '')))
      return false
    return !w.split("'").every((p) => typed.has(p))
  })
}

export interface ProfileCheck {
  name: string
  pass: boolean
  detail?: string
}

export function scoreProfile(f: ProfileFixture, text: string): ProfileCheck[] {
  const checks: ProfileCheck[] = []
  const push = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }
  const lines = text.split('\n').filter((l) => l.trim())
  const listLines = lines.filter((l) => LIST_LINE.test(l))
  const numbered = lines.filter((l) => NUMBERED_LINE.test(l))
  const e = f.expect
  if (e.list === 'none') push('list', listLines.length === 0, `${listLines.length} list lines`)
  else {
    const want = e.items ?? 2
    const asList = e.list === 'ordered' ? numbered.length >= want : listLines.length >= want
    push(
      'list',
      asList || (!!e.inline_ok && listLines.length === 0),
      `${listLines.length} list lines, ${numbered.length} numbered`
    )
  }
  if (e.paragraphs) {
    const paras = text.split(/\n[^\S\n]*\n/).filter((p) => p.trim()).length
    push('paragraphs', paras >= e.paragraphs[0] && paras <= e.paragraphs[1], `${paras}`)
  }
  const tail = text.slice(-80)
  push('ending', new RegExp(e.end, 'i').test(tail), JSON.stringify(tail.slice(-30)))
  const left = (e.split ?? []).filter((r) => new RegExp(r).test(text))
  if (e.split) push('split joined', left.length === 0, left.join(', '))
  const dropped = (e.keep ?? []).filter((k) => !text.toLowerCase().includes(k.toLowerCase()))
  if (e.keep) push('kept wording', dropped.length === 0, dropped.join(', '))
  const invented = inventedWords(f.transcript, text)
  push('no invented words', invented.length === 0, invented.join(' '))
  const lost = lostWords(f.transcript, text)
  push('no lost words', lost.length === 0, lost.join(' '))
  return checks
}

/** Tokens per request, to compare prompts by cost and by the reasoning they set off. */
const tokens = { completion: [] as number[], prompt: [] as number[] }

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
    const usage = (json as { usage?: { completion_tokens?: number; prompt_tokens?: number } }).usage
    tokens.completion.push(usage?.completion_tokens ?? 0)
    tokens.prompt.push(usage?.prompt_tokens ?? 0)
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      finishReason: json.choices?.[0]?.finish_reason
    }
  }

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0
}

describe.skipIf(!enabled)('profiles (live)', () => {
  it(
    `lays out and formats each profile with ${model}`,
    async () => {
      const complete = completeWith(model)
      const runs: unknown[] = []
      const byCheck: Record<string, { pass: number; total: number }> = {}
      const ms: number[] = []
      const outcomes: Record<string, number> = {}
      let passed = 0
      let total = 0
      for (let r = 0; r < RUNS; r++)
        for (const f of loadProfileFixtures()) {
          if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS))
          const p = profileOf(f.profile)
          const ctx: FormatContext = {
            category: f.category,
            tone: p.tone === 'auto' ? autoTone(f.category) : p.tone,
            language: 'auto',
            dictionary: [],
            ...(p.layout !== 'auto' ? { layout: p.layout } : {}),
            ...(p.grammar !== 'polish' ? { grammar: p.grammar } : {})
          }
          const res = await formatTranscript(
            { transcript: f.transcript, mode: 'smart', context: ctx },
            complete
          )
          let text = res.text
          let llmMs = res.llmMs
          const laid = await layoutText(text, f.category, complete, ctx.layout)
          llmMs += laid.llmMs
          if (laid.outcome === 'used') text = laid.text
          text = applyCasing(text, p.casing, f.category)
          ms.push(llmMs)
          outcomes[res.status.outcome] = (outcomes[res.status.outcome] ?? 0) + 1
          const checks = scoreProfile(f, text)
          if (res.status.outcome !== 'used' && res.status.outcome !== 'skipped-clean')
            checks.push({ name: 'model answer kept', pass: false, detail: res.status.detail })
          for (const c of checks) {
            const b = (byCheck[c.name] ??= { pass: 0, total: 0 })
            b.total++
            if (c.pass) b.pass++
          }
          const ok = checks.every((c) => c.pass)
          total++
          if (ok) passed++
          runs.push({
            id: f.id,
            run: r,
            text,
            modelText: res.modelText,
            status: res.status,
            layout: laid.outcome,
            llmMs,
            checks
          })
          console.log(
            `${ok ? 'ok  ' : 'FAIL'} ${f.id} (${llmMs} ms, ${res.status.outcome}) ${
              ok
                ? ''
                : checks
                    .filter((c) => !c.pass)
                    .map((c) => `[${c.name}: ${c.detail}]`)
                    .join(' ')
            }\n     ${JSON.stringify(text)}`
          )
        }
      const summary = {
        model,
        runs: RUNS,
        passed: `${passed}/${total}`,
        checks: Object.fromEntries(
          Object.entries(byCheck).map(([k, v]) => [k, `${v.pass}/${v.total}`])
        ),
        outcomes,
        llmMs: { p50: pct(ms, 0.5), p95: pct(ms, 0.95) },
        completionTokens: {
          mean: Math.round(
            tokens.completion.reduce((a, b) => a + b, 0) / Math.max(1, tokens.completion.length)
          ),
          p50: pct(tokens.completion, 0.5),
          p95: pct(tokens.completion, 0.95)
        },
        promptTokensP50: pct(tokens.prompt, 0.5)
      }
      console.log(JSON.stringify(summary, null, 2))
      writeFileSync(
        resolve(import.meta.dirname, 'last-profiles-live.json'),
        JSON.stringify({ summary, runs }, null, 2)
      )
      expect(total).toBeGreaterThan(0)
    },
    30 * 60_000
  )
})
