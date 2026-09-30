import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * convex/auth.config.ts is evaluated by the Convex CLI at push time. Production must trust Clerk
 * and nothing else: the test issuer the live suites use is added only when both of its variables
 * are set, so a deployment with neither (or one) has exactly one provider.
 */

interface AuthConfig {
  providers: Array<Record<string, string | undefined>>
}

async function load(env: Record<string, string>): Promise<AuthConfig> {
  vi.resetModules()
  vi.unstubAllEnvs()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const mod = (await import('../convex/auth.config')) as { default: AuthConfig }
  return mod.default
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('auth.config.ts', () => {
  it('trusts only the Clerk instance named by CLERK_JWT_ISSUER_DOMAIN', async () => {
    const config = await load({ CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.murmur.app' })
    expect(config.providers).toEqual([
      { domain: 'https://clerk.murmur.app', applicationID: 'convex' }
    ])
  })

  it('leaves the test issuer out unless both of its variables are set', async () => {
    const clerk = { CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.murmur.app' }
    expect(
      (await load({ ...clerk, MURMUR_TEST_JWT_ISSUER: 'https://test.murmur.local' })).providers
    ).toHaveLength(1)
    expect(
      (await load({ ...clerk, MURMUR_TEST_JWKS_URL: 'https://test.murmur.local/jwks' })).providers
    ).toHaveLength(1)
    const dev = await load({
      ...clerk,
      MURMUR_TEST_JWT_ISSUER: 'https://test.murmur.local',
      MURMUR_TEST_JWKS_URL: 'https://test.murmur.local/jwks'
    })
    expect(dev.providers).toHaveLength(2)
    expect(dev.providers[1]).toEqual({
      type: 'customJwt',
      applicationID: 'convex',
      issuer: 'https://test.murmur.local',
      jwks: 'https://test.murmur.local/jwks',
      algorithm: 'RS256'
    })
  })
})
