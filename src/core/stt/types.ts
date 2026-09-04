import type { SttProviderKind } from '@shared/settings'

export interface SttConfig {
  kind: SttProviderKind
  baseUrl: string
  apiKey: string
  model: string
  /** ISO-639-1 code or 'auto'. */
  language: string
  timeoutMs: number
}

export interface TranscribeInput {
  wav: Uint8Array
  prompt?: string
  /** Dictionary terms for providers with keyword boosting (Deepgram keyterm). */
  keyterms?: string[]
  signal?: AbortSignal
}

export interface TranscribeOutput {
  text: string
  language?: string
  durationSec?: number
  noSpeechProb?: number
  latencyMs: number
  raw?: unknown
}

export type SttErrorKind =
  'auth' | 'model' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'bad-request' | 'unknown'

export class SttError extends Error {
  constructor(
    message: string,
    public readonly kind: SttErrorKind,
    public readonly status?: number,
    public readonly suggestedModels: string[] = []
  ) {
    super(message)
    this.name = 'SttError'
  }

  /** Errors worth retrying with a fallback model. */
  get retryable(): boolean {
    return (
      this.kind === 'server' ||
      this.kind === 'model' ||
      this.kind === 'rate-limit' ||
      this.kind === 'timeout'
    )
  }
}

export interface SttProvider {
  readonly kind: SttProviderKind
  transcribe(input: TranscribeInput, cfg: SttConfig): Promise<TranscribeOutput>
  listModels(cfg: SttConfig): Promise<string[]>
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function combineSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs))
  return external ? AbortSignal.any([timeout, external]) : timeout
}

/** Pull a human-readable message and any "available models" hint out of an error body. */
export function parseErrorBody(body: string): { message: string; suggestedModels: string[] } {
  let message = body.trim().slice(0, 500)
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string } | string
      message?: string
      detail?: unknown
    }
    if (typeof json.error === 'string') message = json.error
    else if (json.error?.message) message = json.error.message
    else if (typeof json.message === 'string') message = json.message
    else if (typeof json.detail === 'string') message = json.detail
  } catch {
    // not JSON
  }
  const suggested: string[] = []
  const m = message.match(/available (?:audio )?models?:\s*([^.
]+)/i)
  if (m) {
    for (const part of m[1].split(/[,;]/)) {
      const id = part.trim().replace(/^['"`]|['"`]$/g, '')
      if (id) suggested.push(id)
    }
  }
  return { message, suggestedModels: suggested }
}

export function classifyStatus(status: number, message: string): SttErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 404 || /model/i.test(message)) return 'model'
  if (status >= 500) return 'server'
  if (status >= 400) return 'bad-request'
  return 'unknown'
}

export function toSttError(err: unknown, fallback = 'Transcription failed'): SttError {
  if (err instanceof SttError) return err
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError')
      return new SttError('Request timed out', 'timeout')
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(err.message)) {
      const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
      return new SttError(
        `Cannot reach the server${cause?.code ? ` (${cause.code})` : ''}`,
        'network'
      )
    }
    return new SttError(err.message || fallback, 'unknown')
  }
  return new SttError(fallback, 'unknown')
}

/** Rank model ids so speech models float to the top of pickers. */
export function rankSpeechModels(ids: string[]): string[] {
  const score = (id: string): number => {
    const s = id.toLowerCase()
    if (/whisper|stt|transcri|speech|scribe|voxtral|nova|audio/.test(s)) return 0
    if (/tts|embed|image|vision|rerank|moderation/.test(s)) return 2
    return 1
  }
  return [...ids].sort((a, b) => score(a) - score(b) || a.localeCompare(b))
}
