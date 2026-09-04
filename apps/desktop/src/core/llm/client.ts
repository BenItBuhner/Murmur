import {
  SttError,
  classifyStatus,
  combineSignals,
  normalizeBaseUrl,
  parseErrorBody,
  toSttError
} from '@core/stt/types'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatResult {
  text: string
  latencyMs: number
  model: string
  finishReason?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/** Minimal OpenAI-compatible chat completion client (OpenAI, Groq, Ollama, LM Studio, proxies). */
export async function chatComplete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<ChatResult> {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (!base) throw new SttError('No LLM base URL configured', 'bad-request')
  if (!cfg.model) throw new SttError('No LLM model selected', 'model')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const started = performance.now()
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 512,
        stream: false
      }),
      signal: combineSignals(cfg.timeoutMs, opts.signal)
    })
    if (!res.ok) {
      const { message, suggestedModels } = parseErrorBody(await res.text())
      throw new SttError(
        message || `HTTP ${res.status}`,
        classifyStatus(res.status, message),
        res.status,
        suggestedModels
      )
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | Array<{ text?: string }> }
        finish_reason?: string
      }>
      model?: string
      usage?: ChatResult['usage']
    }
    const choice = json.choices?.[0]
    const content = choice?.message?.content
    const text = Array.isArray(content)
      ? content.map((c) => c.text ?? '').join('')
      : (content ?? '')
    return {
      text,
      latencyMs: Math.round(performance.now() - started),
      model: json.model ?? cfg.model,
      finishReason: choice?.finish_reason,
      usage: json.usage
    }
  } catch (err) {
    throw toSttError(err, 'Formatting request failed')
  }
}

export async function listChatModels(
  cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey'>
): Promise<string[]> {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (!base) throw new SttError('No LLM base URL configured', 'bad-request')
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  try {
    const res = await fetch(`${base}/models`, { headers, signal: combineSignals(15000) })
    if (!res.ok) {
      const { message } = parseErrorBody(await res.text())
      throw new SttError(
        message || `HTTP ${res.status}`,
        classifyStatus(res.status, message),
        res.status
      )
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> }
    const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
    const score = (id: string): number =>
      /whisper|stt|transcri|tts|embed|image|rerank|moderation|audio|scribe/i.test(id) ? 1 : 0
    return [...new Set(ids)].sort((a, b) => score(a) - score(b) || a.localeCompare(b))
  } catch (err) {
    throw toSttError(err, 'Could not list models')
  }
}
