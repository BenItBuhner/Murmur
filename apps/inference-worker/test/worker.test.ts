import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle, type Env } from '../src/index'
import { resetJwksCache, verifyClerkToken } from '../src/clerk'
import { GRANT_TTL_MS, pendingUsage, queueUsage, resetState } from '../src/state'

const ISSUER = 'https://clerk.example.test'
const SITE = 'https://convex.example.test'
const SECRET = 's'.repeat(40)

let keys: CryptoKeyPair
let jwk: JsonWebKey

const b64url = (bytes: Uint8Array | string): string => {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let bin = ''
  for (const b of raw) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function token(claims: Record<string, unknown>, kid = 'k1'): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: ISSUER, aud: 'convex', sub: 'user_ada', exp: now + 60, email: 'ada@example.com', ...claims }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`
}

const env: Env = {
  CLERK_JWT_ISSUER_DOMAIN: ISSUER,
  CONVEX_SITE_URL: SITE,
  MURMUR_WORKER_SECRET: SECRET,
  MURMUR_INFERENCE_STT_URL: 'https://stt.example.test/v1',
  MURMUR_INFERENCE_STT_KEY: 'sk-stt',
  MURMUR_INFERENCE_STT_MODEL: 'whisper-large-v3-turbo',
  MURMUR_INFERENCE_LLM_URL: 'https://llm.example.test/v1',
  MURMUR_INFERENCE_LLM_KEY: 'sk-llm',
  MURMUR_INFERENCE_LLM_MODEL: 'openai/gpt-oss-20b'
}

interface Call {
  url: string
  init?: RequestInit
}
let calls: Call[]
let grant: unknown
let waits: Promise<unknown>[]
const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input)
  calls.push({ url, init })
  if (url === `${ISSUER}/.well-known/jwks.json`) return json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] })
  if (url === `${SITE}/worker/grant`) return json(grant)
  if (url === `${SITE}/worker/usage`) return json({ recorded: 1, dropped: 0 })
  if (url === 'https://stt.example.test/v1/audio/transcriptions') return json({ text: 'hello there world', duration: 2 })
  if (url === 'https://llm.example.test/v1/chat/completions')
    return json({ choices: [{ message: { content: 'Hello there, world.' }, finish_reason: 'stop' }], usage: { total_tokens: 42 } })
  return new Response('not found', { status: 404 })
})

function wav(seconds: number): Uint8Array {
  const rate = 16000
  const data = seconds * rate * 2
  const out = new Uint8Array(44 + data)
  const v = new DataView(out.buffer)
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  tag(0, 'RIFF'); v.setUint32(4, 36 + data, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, data, true)
  return out
}

async function sttRequest(auth: string): Promise<Request> {
  const form = new FormData()
  form.append('file', new Blob([wav(2) as BlobPart], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'murmur-transcribe')
  return new Request('https://w.test/v1/audio/transcriptions', { method: 'POST', headers: { authorization: auth }, body: form })
}

const PRO = { ok: true, plan: 'pro', planState: 'trial', stt: null, llm: null, format: { refusal: null, paused: null } }

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
})

beforeEach(() => {
  calls = []
  waits = []
  grant = PRO
  resetState()
  resetJwksCache()
  vi.stubGlobal('fetch', fetcher)
})

afterEach(() => vi.unstubAllGlobals())

describe('Clerk token verification', () => {
  it('accepts a valid token and rejects foreign, expired or tampered ones', async () => {
    const good = await token({})
    expect(await verifyClerkToken(`Bearer ${good}`, ISSUER, fetcher)).toEqual({ subject: 'user_ada', email: 'ada@example.com', emailVerified: undefined })
    expect(await verifyClerkToken(`Bearer ${await token({ iss: 'https://evil.test' })}`, ISSUER, fetcher)).toBeNull()
    expect(await verifyClerkToken(`Bearer ${await token({ aud: 'other' })}`, ISSUER, fetcher)).toBeNull()
    expect(await verifyClerkToken(`Bearer ${await token({ exp: 1 })}`, ISSUER, fetcher)).toBeNull()
    expect(await verifyClerkToken(`Bearer ${await token({}, 'unknown')}`, ISSUER, fetcher)).toBeNull()
    const [h] = good.split('.')
    const forged = `${h}.${b64url(JSON.stringify({ iss: ISSUER, aud: 'convex', sub: 'user_bob', exp: 9e9 }))}.${good.split('.')[2]}`
    expect(await verifyClerkToken(`Bearer ${forged}`, ISSUER, fetcher)).toBeNull()
    expect(await verifyClerkToken(null, ISSUER, fetcher)).toBeNull()
    expect(await verifyClerkToken('Bearer not.a.jwt', ISSUER, fetcher)).toBeNull()
  })
})

describe('gateway routes', () => {
  it('refuses without a session and when unconfigured', async () => {
    const res = await handle(new Request('https://w.test/v1/models'), env, ctx, fetcher)
    expect(res.status).toBe(401)
    const off = await handle(new Request('https://w.test/v1/models'), { ...env, MURMUR_WORKER_SECRET: '' }, ctx, fetcher)
    expect(off.status).toBe(503)
  })

  it('transcribes without asking Convex per request and batches usage', async () => {
    const auth = `Bearer ${await token({})}`
    for (let i = 0; i < 3; i++) {
      const res = await handle(await sttRequest(auth), env, ctx, fetcher)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ text: 'hello there world' })
    }
    expect(calls.filter((c) => c.url.endsWith('/worker/grant'))).toHaveLength(1)
    expect(calls.filter((c) => c.url.endsWith('/worker/usage'))).toHaveLength(0)
    expect(pendingUsage()).toBe(3)
    const upstream = calls.find((c) => c.url.includes('stt.example.test'))!
    expect((upstream.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-stt')
    expect(waits).toHaveLength(1) // one delayed flush for the whole batch
  })

  it('formats through the text engine and applies refusals from the grant', async () => {
    const auth = `Bearer ${await token({})}`
    const body = JSON.stringify({ transcript: 'hello there world', context: { category: 'other', tone: 'neutral' } })
    const res = await handle(new Request('https://w.test/v1/format', { method: 'POST', headers: { authorization: auth }, body }), env, ctx, fetcher)
    expect(res.status).toBe(200)
    const out = (await res.json()) as { text: string; model: string }
    expect(out.model).toBe('murmur-format')
    expect(typeof out.text).toBe('string')

    resetState()
    grant = { ok: false, denied: 'private_testing' }
    const denied = await handle(await sttRequest(auth), env, ctx, fetcher)
    expect(denied.status).toBe(429)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('private_testing')
  })

  it('answers 503 when Convex cannot be reached for the grant', async () => {
    const auth = `Bearer ${await token({})}`
    const broken = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/worker/grant') ? new Response('down', { status: 500 }) : fetcher(input, init)
    )
    const res = await handle(await sttRequest(auth), env, ctx, broken as typeof fetch)
    expect(res.status).toBe(503)
  })
})

describe('usage buffer', () => {
  it('asks for a send when full', () => {
    const now = Date.now()
    expect(queueUsage({ clerkId: 'a', kind: 'stt', at: now }, now)).toBe('later')
    expect(queueUsage({ clerkId: 'a', kind: 'stt', at: now }, now)).toBe('none')
    let last = 'none'
    for (let i = 0; i < 30; i++) last = queueUsage({ clerkId: 'a', kind: 'llm', at: now }, now)
    expect(last).toBe('now')
    expect(GRANT_TTL_MS).toBeGreaterThan(0)
  })
})
