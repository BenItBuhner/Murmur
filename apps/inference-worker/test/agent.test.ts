import { beforeAll, describe, expect, it, vi } from 'vitest'
import { handle, type Env } from '../src/index'
import { resetJwksCache } from '../src/clerk'
import { resetState } from '../src/state'

const ISSUER = 'https://clerk.example.test'
const SITE = 'https://convex.example.test'
let keys: CryptoKeyPair
let jwk: JsonWebKey

const b64url = (bytes: Uint8Array | string): string => {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function token(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: ISSUER, aud: 'convex', sub: 'user_ada', exp: now + 60 }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`
}
const json = (b: unknown, status = 200): Response =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const env: Env = {
  CLERK_JWT_ISSUER_DOMAIN: ISSUER,
  CONVEX_SITE_URL: SITE,
  MURMUR_WORKER_SECRET: 's'.repeat(40),
  MURMUR_INFERENCE_LLM_URL: 'https://llm.example.test/v1',
  MURMUR_INFERENCE_LLM_KEY: 'sk-llm',
  MURMUR_INFERENCE_LLM_MODEL: 'main-model'
}
const ctx = { waitUntil: () => undefined }
const PRO = { ok: true, plan: 'pro', planState: 'trial', stt: null, llm: null, format: { refusal: null, paused: null } }

let sent: Array<Record<string, unknown>> = []
let failModels: string[] = []
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] })
  if (url === `${SITE}/worker/grant`) return json(PRO)
  if (url === `${SITE}/worker/usage`) return json({ recorded: 1, dropped: 0 })
  if (url === 'https://llm.example.test/v1/chat/completions') {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>
    sent.push({ ...b, _auth: (init?.headers as Record<string, string>).authorization })
    if (failModels.includes(String(b.model))) return new Response('busy', { status: 429 })
    return json({
      id: 'c1',
      choices: [
        {
          message: {
            content: 'Let me file that.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_note', arguments: '{"text":"hi"}' } }]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 20, completion_tokens: 7 }
    })
  }
  return new Response('not found', { status: 404 })
})

const body = {
  model: 'ephemeris',
  system: [{ type: 'text', text: 'You are Ephemeris.' }],
  messages: [
    { role: 'user', content: 'What was on my screen?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_0', name: 'screen', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_0', content: 'A spreadsheet' },
        { type: 'text', text: 'note it' }
      ]
    }
  ],
  tools: [{ name: 'file_note', description: 'File a note', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }]
}
async function req(b: unknown): Promise<Request> {
  return new Request('https://w.test/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}` },
    body: JSON.stringify(b)
  })
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
})

function reset(): void {
  sent = []
  failModels = []
  resetState()
  resetJwksCache()
}

describe('Ephemeris agent on the managed formatting provider (no Anthropic key)', () => {
  it('converts to a chat completion with tools on the server model and back to Messages', async () => {
    reset()
    const res = await handle(await req(body), env, ctx, fetcher as typeof fetch)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { content: unknown[]; stop_reason: string; usage: unknown; model: string }
    expect(out.stop_reason).toBe('tool_use')
    expect(out.model).toBe('ephemeris')
    expect(out.content).toEqual([
      { type: 'text', text: 'Let me file that.' },
      { type: 'tool_use', id: 'call_1', name: 'file_note', input: { text: 'hi' } }
    ])
    expect(out.usage).toEqual({ input_tokens: 20, output_tokens: 7 })
    const s = sent[0]!
    expect(s.model).toBe('main-model')
    expect(s._auth).toBe('Bearer sk-llm')
    const msgs = s.messages as Array<Record<string, unknown>>
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are Ephemeris.' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'What was on my screen?' })
    expect(msgs[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_0', function: { name: 'screen', arguments: '{}' } }] })
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'A spreadsheet' })
    expect(msgs[4]).toEqual({ role: 'user', content: 'note it' })
    expect((s.tools as unknown[])[0]).toMatchObject({ type: 'function', function: { name: 'file_note' } })
    expect(s.tool_choice).toBe('auto')
  })

  it('streams as Messages events when asked', async () => {
    reset()
    const res = await handle(await req({ ...body, stream: true }), env, ctx, fetcher as typeof fetch)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text.startsWith('event: message_start')).toBe(true)
    expect(text).toContain('"type":"input_json_delta"')
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(text.trim().endsWith('data: {"type":"message_stop"}')).toBe(true)
  })

  it('falls back to the next model when one fails, and refuses when all do', async () => {
    reset()
    failModels = ['main-model']
    const withHedge = { ...env, MURMUR_INFERENCE_LLM_HEDGE_MODEL: 'backup-model' }
    const res = await handle(await req(body), withHedge, ctx, fetcher as typeof fetch)
    expect(res.status).toBe(200)
    expect(sent.map((s) => s.model)).toEqual(['main-model', 'backup-model'])
    reset()
    failModels = ['main-model', 'backup-model']
    expect((await handle(await req(body), withHedge, ctx, fetcher as typeof fetch)).status).toBe(503)
  })
})
