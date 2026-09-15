import { readFile } from 'node:fs/promises'
import type { TestAuthIdentity } from '@shared/cloud'
import { createLogger } from '../logger'
import type { TokenSource } from './sync-engine'

const log = createLogger('cloud:test-auth')

/** Environment knob: a file holding one Convex JWT minted by an issuer the deployment trusts. */
export const TEST_AUTH_TOKEN_FILE = 'MURMUR_TEST_AUTH_TOKEN_FILE'

export interface TestAuth {
  tokenFile: string
  identity: TestAuthIdentity
}

/**
 * Development-only stand-in for Clerk: with `MURMUR_TEST_AUTH_TOKEN_FILE` set, a dev build treats
 * the token in that file as the signed-in session, the way the live suites do, and signs in as the
 * token's `sub`. The backend has to trust the issuer (MURMUR_TEST_JWT_ISSUER / MURMUR_TEST_JWKS_URL
 * on a development deployment). Packaged builds ignore the variable.
 */
export function resolveTestAuth(
  env: Record<string, string | undefined>,
  token: string | null,
  allowed: boolean
): TestAuth | null {
  const tokenFile = (env[TEST_AUTH_TOKEN_FILE] ?? '').trim()
  if (!tokenFile) return null
  if (!allowed) {
    log.warn(`${TEST_AUTH_TOKEN_FILE} is ignored in packaged builds`)
    return null
  }
  const identity = token ? identityFromJwt(token) : null
  if (!identity) {
    log.warn(`${TEST_AUTH_TOKEN_FILE} does not hold a JWT with a subject; ignoring it`)
    return null
  }
  return { tokenFile, identity }
}

/** The `sub`, `email` and `name` claims of a JWT, without verifying it (the backend does that). */
export function identityFromJwt(token: string): TestAuthIdentity | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (typeof claims.sub !== 'string' || !claims.sub) return null
    return {
      userId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined
    }
  } catch {
    return null
  }
}

/**
 * Token source that reads the file on every request, so a test can rotate the token (a fresh
 * expiry, another account) without restarting the app. Missing or empty file: no session.
 */
export class FileTokenSource implements TokenSource {
  constructor(
    private readonly file: string,
    private readonly read: (file: string) => Promise<string> = (f) => readFile(f, 'utf8')
  ) {}

  async request(): Promise<string | null> {
    try {
      const token = (await this.read(this.file)).trim()
      return token || null
    } catch (err) {
      log.warn(`could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
}
