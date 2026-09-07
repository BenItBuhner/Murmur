import {
  SttError,
  combineSignals,
  errorFromResponse,
  normalizeBaseUrl,
  rankSpeechModels,
  toSttError,
  type SttConfig,
  type SttProvider,
  type TimedSpan,
  type TranscribeInput,
  type TranscribeOutput
} from './types'

interface VerboseJson {
  text?: string
  language?: string
  duration?: number
  segments?: Array<{ start?: number; end?: number; no_speech_prob?: number; avg_logprob?: number }>
  words?: Array<{ word?: string; start?: number; end?: number }>
}

/** Servers that rejected verbose_json once are remembered so we do not pay a failed round-trip again. */
const verboseUnsupported = new Set<string>()
/** Servers that rejected word-level timestamps; they still get verbose_json for segment timings. */
const wordTimestampsUnsupported = new Set<string>()

/**
 * Timed spans from a verbose response. Word timings win: they come from alignment and stay right
 * even when the decoder stopped early, whereas a segment that was never closed with a timestamp
 * is reported as running to the end of its 30-second window.
 */
export function spansFromVerbose(json: VerboseJson | undefined): TimedSpan[] | undefined {
  if (!json) return undefined
  const valid = (s: { start?: number; end?: number }): s is TimedSpan =>
    typeof s.start === 'number' &&
    typeof s.end === 'number' &&
    Number.isFinite(s.start) &&
    Number.isFinite(s.end) &&
    s.end >= 0
  const words = (json.words ?? []).filter(valid).map((w) => ({ start: w.start, end: w.end }))
  if (words.length) return words
  const segments = (json.segments ?? []).filter(valid).map((s) => ({ start: s.start, end: s.end }))
  return segments.length ? segments : undefined
}

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

    const attempt = async (verbose: boolean, wordTimestamps: boolean): Promise<Response> => {
      const form = new FormData()
      form.append('file', new Blob([input.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', cfg.model)
      form.append('response_format', verbose ? 'verbose_json' : 'json')
      form.append('temperature', '0')
      if (verbose && wordTimestamps) {
        form.append('timestamp_granularities[]', 'word')
        form.append('timestamp_granularities[]', 'segment')
      }
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
      const wantWords = wantVerbose && !wordTimestampsUnsupported.has(base)
      let res = await attempt(wantVerbose, wantWords)
      if (!res.ok && res.status === 400 && wantWords) {
        // Word timestamps are the newest thing we ask for, so they are the first suspect for a
        // rejected request: try once without them before judging the error. A server that names
        // the field is remembered so the extra round-trip is not paid again.
        const body = await res.text()
        if (/timestamp_granularities|granularit/i.test(body)) wordTimestampsUnsupported.add(base)
        res = await attempt(true, false)
      }
      if (!res.ok && wantVerbose && res.status === 400) {
        const body = await res.text()
        if (/response_format|verbose/i.test(body)) {
          verboseUnsupported.add(base)
          res = await attempt(false, false)
        } else {
          throw errorFromResponse(res.status, body)
        }
      }
      if (!res.ok) throw errorFromResponse(res.status, await res.text())
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
        spans: spansFromVerbose(json),
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
      if (!res.ok) throw errorFromResponse(res.status, await res.text())
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
