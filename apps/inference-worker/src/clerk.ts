import type { GatewayIdentity } from '../../../packages/backend/convex/lib/inference'

/**
 * Clerk session JWT verification with the instance's JWKS, the same check Convex does for the
 * `convex` JWT template (auth.config.ts): RS256, issuer = CLERK_JWT_ISSUER_DOMAIN, audience
 * `convex`, inside its validity window. Keys are cached per isolate for an hour and refetched once
 * when a token names a key id the cache does not have (Clerk rotated).
 */

const AUDIENCE = 'convex'
const JWKS_TTL_MS = 60 * 60_000
const CLOCK_SKEW_SEC = 30

interface Jwk extends JsonWebKey {
  kid?: string
}

let jwksCache: { issuer: string; at: number; keys: Map<string, CryptoKey> } | null = null

/** Test hook: forget cached keys. */
export function resetJwksCache(): void {
  jwksCache = null
}

function b64urlBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlJson(input: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(b64urlBytes(input)))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function loadKeys(issuer: string, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  const res = await fetcher(`${issuer}/.well-known/jwks.json`)
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = new Map<string, CryptoKey>()
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    keys.set(jwk.kid, key)
  }
  jwksCache = { issuer, at: Date.now(), keys }
  return keys
}

async function keyFor(issuer: string, kid: string, fetcher: typeof fetch): Promise<CryptoKey | null> {
  const fresh = jwksCache && jwksCache.issuer === issuer && Date.now() - jwksCache.at < JWKS_TTL_MS
  if (fresh && jwksCache!.keys.has(kid)) return jwksCache!.keys.get(kid)!
  const keys = await loadKeys(issuer, fetcher)
  return keys.get(kid) ?? null
}

/**
 * The identity behind `Authorization: Bearer <Clerk JWT>`, or null for a missing, malformed,
 * expired or foreign token. Never throws for a bad token; a JWKS outage does throw.
 */
export async function verifyClerkToken(
  authorization: string | null,
  issuerDomain: string,
  fetcher: typeof fetch = fetch,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<GatewayIdentity | null> {
  const issuer = issuerDomain.trim().replace(/\/+$/, '')
  if (!issuer || !authorization?.startsWith('Bearer ')) return null
  const parts = authorization.slice(7).trim().split('.')
  if (parts.length !== 3) return null
  const header = b64urlJson(parts[0])
  const claims = b64urlJson(parts[1])
  if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return null
  if (claims.iss !== issuer) return null
  const aud = claims.aud
  if (!(aud === AUDIENCE || (Array.isArray(aud) && aud.includes(AUDIENCE)))) return null
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < nowSec) return null
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > nowSec) return null
  if (typeof claims.sub !== 'string' || !claims.sub) return null
  const key = await keyFor(issuer, header.kid, fetcher)
  if (!key) return null
  let signature: Uint8Array
  try {
    signature = b64urlBytes(parts[2])
  } catch {
    return null
  }
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource
  )
  if (!ok) return null
  return {
    subject: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    emailVerified: typeof claims.email_verified === 'boolean' ? claims.email_verified : undefined
  }
}
