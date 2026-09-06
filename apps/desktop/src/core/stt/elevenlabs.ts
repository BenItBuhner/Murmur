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

export const ELEVENLABS_DEFAULT_BASE = 'https://api.elevenlabs.io/v1'
export const ELEVENLABS_MODELS = ['scribe_v1', 'scribe_v1_experimental']

export class ElevenLabsStt implements SttProvider {
  readonly kind = 'elevenlabs' as const

  async transcribe(input: TranscribeInput, cfg: SttConfig): Promise<TranscribeOutput> {
    const base = normalizeBaseUrl(cfg.baseUrl || ELEVENLABS_DEFAULT_BASE)
    if (!cfg.apiKey) throw new SttError('ElevenLabs requires an API key', 'auth')
    const form = new FormData()
    form.append('file', new Blob([input.wav as BlobPart], { type: 'audio/wav' }), 'audio.wav')
    form.append('model_id', cfg.model || 'scribe_v1')
    form.append('tag_audio_events', 'false')
    form.append('diarize', 'false')
    if (cfg.language && cfg.language !== 'auto') form.append('language_code', cfg.language)
    const started = performance.now()
    try {
      const res = await fetch(`${base}/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': cfg.apiKey },
        body: form,
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
      const json = (await res.json()) as {
        text?: string
        language_code?: string
        words?: Array<{ type?: string; start?: number; end?: number }>
      }
      const spans = (json.words ?? [])
        .filter(
          (w) =>
            (w.type ?? 'word') === 'word' &&
            typeof w.start === 'number' &&
            typeof w.end === 'number'
        )
        .map((w) => ({ start: w.start as number, end: w.end as number }))
      return {
        text: (json.text ?? '').trim(),
        language: json.language_code,
        latencyMs: Math.round(performance.now() - started),
        spans: spans.length ? spans : undefined,
        raw: json
      }
    } catch (err) {
      throw toSttError(err)
    }
  }

  async listModels(): Promise<string[]> {
    return ELEVENLABS_MODELS
  }
}
