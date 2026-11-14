import { finish } from '@/lib/engine/cleanup'
import { autoTone } from '@/lib/engine/context'
import { buildSttPrompt } from '@/lib/engine/dictionary'
import { formatTranscript } from '@/lib/engine/format'
import { stripPromptEcho } from '@/lib/engine/prompt-echo'
import type { AppCategory, FormatContext, FormatOutcome, FormatResult } from '@/lib/engine/types'
import type { AccountSettings } from './settings'

/** The text lands in a plain field to be copied anywhere, so it is written like a note. */
export const CATEGORY: AppCategory = 'notes'

/** Model id the gateway accepts (packages/backend/convex/lib/inference.ts MURMUR_MODELS). */
export const STT_MODEL = 'murmur-transcribe'

/**
 * The site reaches the gateway through its own origin (app/api/gateway), because neither the
 * inference Worker nor the Convex HTTP actions send CORS headers.
 */
export const GATEWAY_BASE = '/api/gateway/v1'

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

export interface PipelineDeps {
  gatewayUrl: string
  /** A fresh token when `force` (after a 401), the cached one otherwise. */
  token: (force: boolean) => Promise<string | null>
  fetch?: typeof fetch
}

export interface DictationResult {
  text: string
  raw: string
  formatting: FormatOutcome | 'local'
  ms: number
}

async function gatewayError(res: Response): Promise<GatewayError> {
  let message = `The speech server answered ${res.status}`
  let code: string | undefined
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } }
    if (body.error?.message) message = body.error.message
    code = body.error?.code
  } catch {
    /* not JSON */
  }
  return new GatewayError(message, res.status, code)
}

/** One gateway call with the session token; a 401 refreshes the token once and tries again. */
async function authed(
  deps: PipelineDeps,
  path: string,
  init: (token: string) => RequestInit
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch
  for (const force of [false, true]) {
    const token = await deps.token(force)
    if (!token) throw new GatewayError('Sign in to transcribe', 401, 'unauthorized')
    const res = await doFetch(`${deps.gatewayUrl}${path}`, init(token))
    if (res.status === 401 && !force) continue
    if (res.status === 401)
      throw new GatewayError('Your session expired; sign in again', 401, 'unauthorized')
    if (!res.ok) throw await gatewayError(res)
    return res
  }
  throw new GatewayError('Your session expired; sign in again', 401, 'unauthorized')
}

export function formatContext(s: AccountSettings): FormatContext {
  return {
    category: CATEGORY,
    app: 'Murmur web',
    tone: s.formatting.tone === 'auto' ? autoTone(CATEGORY) : s.formatting.tone,
    language: s.language,
    instructions: s.formatting.instructions || undefined,
    dictionary: s.dictionary,
    keepVerbatim: s.snippets.map((x) => x.trigger)
  }
}

export function sttPrompt(s: AccountSettings): string | undefined {
  return s.useDictionaryPrompt
    ? buildSttPrompt(
        s.dictionary,
        s.snippets.map((x) => x.trigger)
      )
    : undefined
}

/** Speech to text on the gateway (`POST /v1/audio/transcriptions`), as the desktop app sends it. */
export async function transcribe(
  wav: Blob,
  s: AccountSettings,
  deps: PipelineDeps
): Promise<string> {
  const prompt = sttPrompt(s)
  const res = await authed(deps, '/audio/transcriptions', (token) => {
    const form = new FormData()
    form.append('file', wav, 'audio.wav')
    form.append('model', STT_MODEL)
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (s.language && s.language !== 'auto') form.append('language', s.language)
    if (prompt) form.append('prompt', prompt)
    return { method: 'POST', body: form, headers: { Authorization: `Bearer ${token}` } }
  })
  const json = (await res.json()) as { text?: string }
  return stripPromptEcho((json.text ?? '').trim(), prompt).trim()
}

/** Formatting: the gateway's engine for Smart (`POST /v1/format`), the local rules otherwise. */
export async function format(
  transcript: string,
  s: AccountSettings,
  deps: PipelineDeps
): Promise<FormatResult | null> {
  const context = formatContext(s)
  if (s.formatting.mode !== 'smart')
    return formatTranscript({ transcript, mode: s.formatting.mode, context }, null)
  try {
    const res = await authed(deps, '/format', (token) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ transcript, context })
    }))
    const json = (await res.json()) as Partial<FormatResult>
    if (typeof json.text !== 'string' || !json.status) return null
    return json as FormatResult
  } catch {
    // Formatting never loses a dictation: the rule-based result stands in, as on desktop.
    return formatTranscript({ transcript, mode: 'light', context }, null)
  }
}

/** The whole dictation: speech, formatting, then the exact parts (dictionary, snippets). */
export async function dictate(
  wav: Blob,
  s: AccountSettings,
  deps: PipelineDeps
): Promise<DictationResult> {
  const started = performance.now()
  const raw = await transcribe(wav, s, deps)
  if (!raw)
    return { text: '', raw, formatting: 'local', ms: Math.round(performance.now() - started) }
  const formatted = await format(raw, s, deps)
  const finished = finish(formatted?.text ?? raw, {
    category: CATEGORY,
    dictionary: s.dictionary,
    trailingSpace: s.formatting.trailingSpace,
    snippets: s.snippets,
    snippetContext: { now: new Date() }
  })
  return {
    text: finished.text,
    raw,
    formatting: s.formatting.mode === 'smart' ? (formatted?.status.outcome ?? 'failed') : 'local',
    ms: Math.round(performance.now() - started)
  }
}
