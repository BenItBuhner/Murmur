import {
  SttError,
  classifyStatus,
  combineSignals,
  normalizeBaseUrl,
  parseErrorBody,
  toSttError,
  type SttConfig,
  type SttProvider,
  type TranscribeInput,
  type TranscribeOutput
} from './types'

interface DeepgramResponse {
  metadata?: { duration?: number }
  results?: {
    channels?: Array<{
      detected_language?: string
      alternatives?: Array<{
        transcript?: string
        confidence?: number
        words?: Array<{ start?: number; end?: number }>
      }>
    }>
  }
}

export const DEEPGRAM_DEFAULT_BASE = 'https://api.deepgram.com/v1'
export const DEEPGRAM_MODELS = ['nova-3', 'nova-2', 'nova-3-medical', 'enhanced', 'base']

export class DeepgramStt implements SttProvider {
  readonly kind = 'deepgram' as const

  async transcribe(input: TranscribeInput, cfg: SttConfig): Promise<TranscribeOutput> {
    const base = normalizeBaseUrl(cfg.baseUrl || DEEPGRAM_DEFAULT_BASE)
    if (!cfg.apiKey) throw new SttError('Deepgram requires an API key', 'auth')
    const params = new URLSearchParams()
    params.set('model', cfg.model || 'nova-3')
    params.set('smart_format', 'true')
    params.set('punctuate', 'true')
    if (cfg.language && cfg.language !== 'auto') params.set('language', cfg.language)
    else params.set('detect_language', 'true')
    // nova-3 supports `keyterm`; older models use `keywords`.
    const usesKeyterm = /nova-3/.test(cfg.model)
    for (const term of (input.keyterms ?? []).slice(0, 50)) {
      params.append(usesKeyterm ? 'keyterm' : 'keywords', usesKeyterm ? term : `${term}:2`)
    }
    const started = performance.now()
    try {
      const res = await fetch(`${base}/listen?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': 'audio/wav' },
        body: input.wav as BodyInit,
        signal: combineSignals(cfg.timeoutMs, input.signal)
      })
      if (!res.ok) {
        const { message } = parseErrorBody(await res.text())
        throw new SttError(
          message || `HTTP ${res.status}`,
          classifyStatus(res.status, message),
          res.status
        )
      }
      const json = (await res.json()) as DeepgramResponse
      const channel = json.results?.channels?.[0]
      const alternative = channel?.alternatives?.[0]
      const text = alternative?.transcript ?? ''
      const spans = (alternative?.words ?? [])
        .filter((w) => typeof w.start === 'number' && typeof w.end === 'number')
        .map((w) => ({ start: w.start as number, end: w.end as number }))
      return {
        text: text.trim(),
        language: channel?.detected_language,
        durationSec: json.metadata?.duration,
        latencyMs: Math.round(performance.now() - started),
        spans: spans.length ? spans : undefined,
        raw: json
      }
    } catch (err) {
      throw toSttError(err)
    }
  }

  async listModels(cfg: SttConfig): Promise<string[]> {
    const base = normalizeBaseUrl(cfg.baseUrl || DEEPGRAM_DEFAULT_BASE)
    if (!cfg.apiKey) return DEEPGRAM_MODELS
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Token ${cfg.apiKey}` },
        signal: combineSignals(10000)
      })
      if (!res.ok) return DEEPGRAM_MODELS
      const json = (await res.json()) as { stt?: Array<{ canonical_name?: string; name?: string }> }
      const ids = new Set<string>()
      for (const m of json.stt ?? []) {
        const id = m.canonical_name ?? m.name
        if (id) ids.add(id)
      }
      return ids.size ? [...ids].sort() : DEEPGRAM_MODELS
    } catch {
      return DEEPGRAM_MODELS
    }
  }
}
