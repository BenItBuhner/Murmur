/**
 * The Ephemeris agent speaks Anthropic Messages (with tools); the managed formatting provider speaks
 * OpenAI chat completions. These convert one to the other and back, so the agent runs on the same
 * provider, key and models the gateway already uses, with no key of its own.
 */

type Json = Record<string, unknown>

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function blocks(content: unknown): AnthropicBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as AnthropicBlock[]) : []
}

function textOf(content: unknown): string {
  return blocks(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

/** An Anthropic Messages request as an OpenAI chat-completions body (model left to the caller). */
export function toChatRequest(input: Json): Json {
  const messages: Json[] = []
  const system = textOf(input.system)
  if (system) messages.push({ role: 'system', content: system })
  for (const m of (Array.isArray(input.messages) ? input.messages : []) as Json[]) {
    const parts = blocks(m.content)
    if (m.role === 'assistant') {
      const text = parts.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
      const calls = parts
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    // user: tool results become tool messages (in order), the rest one user message
    for (const r of parts.filter((b) => b.type === 'tool_result'))
      messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: (r.is_error ? 'Error: ' : '') + textOf(r.content) })
    const text = parts
      .filter((b) => b.type !== 'tool_result')
      .map((b) => (b.type === 'text' ? (b.text ?? '') : b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n')
    if (text) messages.push({ role: 'user', content: text })
  }
  const out: Json = { messages, stream: false }
  const tools = Array.isArray(input.tools) ? (input.tools as Json[]).filter((t) => typeof t.name === 'string' && t.input_schema) : []
  if (tools.length) {
    out.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema }
    }))
    const choice = input.tool_choice as Json | undefined
    if (choice?.type === 'any') out.tool_choice = 'required'
    else if (choice?.type === 'none') out.tool_choice = 'none'
    else if (choice?.type === 'tool' && typeof choice.name === 'string')
      out.tool_choice = { type: 'function', function: { name: choice.name } }
    else out.tool_choice = 'auto'
  }
  if (typeof input.temperature === 'number') out.temperature = input.temperature
  if (typeof input.top_p === 'number') out.top_p = input.top_p
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length) out.stop = input.stop_sequences.slice(0, 4)
  return out
}

/** An OpenAI chat-completions answer as an Anthropic Messages answer. */
export function toAnthropicMessage(chat: Json, model: string): Json {
  const choice = ((chat.choices as Json[] | undefined) ?? [])[0] ?? {}
  const msg = (choice.message as Json | undefined) ?? {}
  const content: Json[] = []
  const text = typeof msg.content === 'string' ? msg.content : ''
  if (text) content.push({ type: 'text', text })
  for (const c of ((msg.tool_calls as Json[] | undefined) ?? []) as Json[]) {
    const fn = (c.function as Json | undefined) ?? {}
    let args: unknown = {}
    try {
      args = typeof fn.arguments === 'string' && fn.arguments ? JSON.parse(fn.arguments) : (fn.arguments ?? {})
    } catch {
      args = { _raw: fn.arguments }
    }
    content.push({ type: 'tool_use', id: String(c.id ?? `toolu_${Math.random().toString(36).slice(2)}`), name: fn.name, input: args })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  const finish = choice.finish_reason
  const stop_reason = content.some((b) => b.type === 'tool_use')
    ? 'tool_use'
    : finish === 'length'
      ? 'max_tokens'
      : finish === 'stop' && typeof chat.stop === 'string'
        ? 'stop_sequence'
        : 'end_turn'
  const usage = (chat.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {}
  return {
    id: `msg_${String(chat.id ?? Date.now().toString(36))}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 }
  }
}

/** A finished Anthropic message replayed as the Messages streaming events, for clients that stream. */
export function messageAsEventStream(message: Json): string {
  const ev = (type: string, data: Json): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const usage = message.usage as Json
  let out = ev('message_start', {
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } }
  })
  ;(message.content as Json[]).forEach((b, index) => {
    if (b.type === 'tool_use') {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } })
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
      if (b.text) out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    }
    out += ev('content_block_stop', { index })
  })
  out += ev('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  out += ev('message_stop', {})
  return out
}
