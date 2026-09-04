import {
  SttError,
  classifyStatus,
  combineSignals,
  normalizeBaseUrl,
  parseErrorBody,
  rankSpeechModels,
  toSttError,
  type SttConfig,
  type SttProvider,
  type TranscribeInput,
  type TranscribeOutput
} from './types'

interface VerboseJson {
  text?: string
  language?: string
  duration?: number
  segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }>
}

/** Servers that rejected verbose_json once are remembered so we do not pay a failed round-trip again. */
const verboseUnsupported = new Set<string>()

/**
 * Works with OpenAI, Groq, Mistral, whisper.cpp `server`, faster-whisper-server/Speaches,
 * LocalAI, and any proxy that speaks `POST /audio/transcriptions`.
 */
export class OpenAiCompatibleStt implements SttProvider {
  readonly kind = 'openai-compatible' as const

  async transcribe(input: TranscribeInput, cfg: SttConfig): Promise<TranscribeOutput> {
    const base = normalizeBaseUrl(cfg.baseUrl)
    if (!base) throw new SttError('No STT base URL configured', 'bad-request')
    if (!cfg.model) throw new SttError('No STT model selected', 'model')
    const url = `${base}/audio/transcriptions`
    const wantVerbose = !verboseUnsupported.has(base)
    const started = performance.now()

    const attempt = async (verbose: boolean): Promise<Response> => {
      const form = new FormData()
      form.append('file', new Blob([input.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', cfg.model)
      form.append('response_format', verbose ? 'verbose_json' : 'json')
      form.append('temperature', '0')
      if (cfg.language && cfg.language !== 'auto') form.append('language', cfg.language)
      if (input.prompt) form.append('prompt', input.prompt)
      const headers: Record<string, string> = {}
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
      return fetch(url, {
        method: 'POST',
        body: form,
        headers,
        signal: combineSignals(cfg.timeoutMs, input.signal)
      })
    }

    try {
      let res = await attempt(wantVerbose)
      if (!res.ok && wantVerbose && res.status === 400) {
        const body = await res.text()
        if (/response_format|verbose/i.test(body)) {
          verboseUnsupported.add(base)
          res = await attempt(false)
        } else {
          const { message, suggestedModels } = parseErrorBody(body)
          throw new SttError(
            message,
            classifyStatus(res.status, message),
            res.status,
            suggestedModels
          )
        }
      }
      if (!res.ok) {
        const body = await res.text()
        const { message, suggestedModels } = parseErrorBody(body)
        throw new SttError(
          message || `HTTP ${res.status}`,
          classifyStatus(res.status, message),
          res.status,
          suggestedModels
        )
      }
      const contentType = res.headers.get('content-type') ?? ''
      let text = ''
      let json: VerboseJson | undefined
      if (contentType.includes('json')) {
        json = (await res.json()) as VerboseJson
        text = json.text ?? ''
      } else {
        text = await res.text()
      }
      const noSpeech = json?.segments?.length
        ? json.segments.reduce((acc, s) => acc + (s.no_speech_prob ?? 0), 0) / json.segments.length
        : undefined
      return {
        text: text.trim(),
        language: json?.language,
        durationSec: json?.duration,
        noSpeechProb: noSpeech,
        latencyMs: Math.round(performance.now() - started),
        raw: json
      }
    } catch (err) {
      throw toSttError(err)
    }
  }

  async listModels(cfg: SttConfig): Promise<string[]> {
    const base = normalizeBaseUrl(cfg.baseUrl)
    if (!base) throw new SttError('No base URL configured', 'bad-request')
    const headers: Record<string, string> = {}
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    try {
      const res = await fetch(`${base}/models`, {
        headers,
        signal: combineSignals(Math.min(cfg.timeoutMs, 15000))
      })
      if (!res.ok) {
        const { message } = parseErrorBody(await res.text())
        throw new SttError(
          message || `HTTP ${res.status}`,
          classifyStatus(res.status, message),
          res.status
        )
      }
      const json = (await res.json()) as {
        data?: Array<{ id: string }>
        models?: Array<{ name?: string; id?: string }>
      }
      const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
      if (!ids.length && json.models)
        ids.push(...json.models.map((m) => m.id ?? m.name ?? '').filter(Boolean))
      return rankSpeechModels([...new Set(ids)])
    } catch (err) {
      throw toSttError(err, 'Could not list models')
    }
  }
}
