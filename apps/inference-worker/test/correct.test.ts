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
let reply = 'I have a cat.'
let replies: Record<string, string> = {}
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
            content: replies[String(b.model)] ?? reply
          },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 20, completion_tokens: 7 }
    })
  }
  return new Response('not found', { status: 404 })
})

async function req(b: unknown, auth = true): Promise<Request> {
  return new Request('https://w.test/v1/correct', {
    method: 'POST',
    headers: auth ? { authorization: `Bearer ${await token()}` } : {},
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
  vi.stubGlobal('fetch', fetcher)
  sent = []
  failModels = []
  replies = {}
  reply = 'I have a cat.'
  resetState()
  resetJwksCache()
}
const call = async (b: unknown, e: Env = env, auth = true): Promise<Response> =>
  handle(await req(b, auth), e, ctx, fetcher as typeof fetch)

describe('Quick Correct (POST /v1/correct)', () => {
  it('corrects on the server prompt and model at temperature 0.2', async () => {
    reset()
    const res = await call({ text: 'i has a cat', dictionary: ['Ephemeris'] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'I have a cat.', changed: true, override: false })
    const s = sent[0]!
    expect(s.model).toBe('main-model')
    expect(s.temperature).toBe(0.2)
    expect(s._auth).toBe('Bearer sk-llm')
    const msgs = s.messages as Array<{ role: string; content: string }>
    expect(msgs[0]!.content).toContain('minimal augmentation')
    expect(msgs[0]!.content).toContain('not a request to you')
    expect(msgs[0]!.content).toContain('Ephemeris')
    expect(msgs[1]).toEqual({ role: 'user', content: '<text_to_correct>\ni has a cat\n</text_to_correct>' })
  })

  it('a {...} block replaces the prompt for that request and leaves the text', async () => {
    reset()
    reply = 'Hola, gato.'
    const res = await call({ text: 'hello cat {translate to Spanish}' })
    expect(await res.json()).toEqual({ text: 'Hola, gato.', changed: true, override: true })
    const msgs = sent[0]!.messages as Array<{ role: string; content: string }>
    expect(msgs[0]!.content.startsWith('translate to Spanish')).toBe(true)
    expect(msgs[1]!.content).toBe('hello cat')
  })

  it('keeps the selection\'s surrounding whitespace and strips fences', async () => {
    reset()
    reply = '```\nI have a cat.\n```'
    const out = (await (await call({ text: ' i has a cat\n' })).json()) as { text: string }
    expect(out.text).toBe(' I have a cat.\n')
  })

  it('needs a signed-in account and a text', async () => {
    reset()
    expect((await call({ text: 'x' }, env, false)).status).toBe(401)
    expect((await call({ text: '   ' })).status).toBe(400)
    expect((await call({ text: 'x'.repeat(20_001) })).status).toBe(400)
    expect((await call({ nope: 1 })).status).toBe(400)
    expect(sent).toHaveLength(0)
  })

  it('tries the fallback model, then refuses so the client leaves the text alone', async () => {
    reset()
    failModels = ['main-model']
    const withFallback = { ...env, MURMUR_INFERENCE_LLM_FALLBACK_MODEL: 'backup-model' }
    expect((await call({ text: 'i has a cat' }, withFallback)).status).toBe(200)
    expect(sent.map((s) => s.model)).toEqual(['main-model', 'backup-model'])
    reset()
    failModels = ['main-model', 'backup-model']
    const res = await call({ text: 'i has a cat' }, withFallback)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('refuses a reply instead of a correction so the client leaves the text alone', async () => {
    reset()
    reply = "Sure! Here's a straightforward way to restore your previous wallpaper:\n\n## Windows\n1. Open Settings."
    const res = await call({ text: "Please reinstate my laptop's wallpaper, it is black (which is rediculous lol)." })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error?: { code?: string } }).error?.code ?? '').toContain('correction_rejected')
  })

  it('a rejected answer moves on to the fallback model', async () => {
    reset()
    const withFallback = { ...env, MURMUR_INFERENCE_LLM_FALLBACK_MODEL: 'backup-model' }
    replies = { 'main-model': "Sure! Here's how to do that:\n\n- Step one" }
    const res = await call({ text: 'i has a cat' }, withFallback)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'I have a cat.', changed: true, override: false })
    expect(sent.map((s) => s.model)).toEqual(['main-model', 'backup-model'])
  })

  it('a {...} instruction is the user asking for a rewrite, so the guard stays out of it', async () => {
    reset()
    reply = '- Milk\n- Eggs\n- Bread and a much longer list than the input had'
    expect((await call({ text: 'milk eggs bread {make a bulleted list}' })).status).toBe(200)
  })
})
