import { describe, expect, it } from 'vitest'
import { resolveCloudConfig } from '../src/main/cloud/config'
import {
  FileTokenSource,
  identityFromJwt,
  resolveTestAuth,
  TEST_AUTH_TOKEN_FILE
} from '../src/main/cloud/test-auth'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (claims: Record<string, unknown>): string =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

describe('identityFromJwt', () => {
  it('reads the subject and the optional profile claims without verifying the token', () => {
    expect(identityFromJwt(jwt({ sub: 'user_1', email: 'a@b.test', name: 'Ada' }))).toEqual({
      userId: 'user_1',
      email: 'a@b.test',
      name: 'Ada'
    })
    expect(identityFromJwt(` ${jwt({ sub: 'user_2', email: 7 })}\n`)).toEqual({
      userId: 'user_2',
      email: undefined,
      name: undefined
    })
  })

  it('rejects anything that is not a JWT with a subject', () => {
    expect(identityFromJwt('')).toBeNull()
    expect(identityFromJwt('not.a.jwt.at.all')).toBeNull()
    expect(identityFromJwt(jwt({ email: 'nobody@b.test' }))).toBeNull()
    expect(identityFromJwt('a.@@@.c')).toBeNull()
  })
})

describe('resolveTestAuth', () => {
  const token = jwt({ sub: 'user_e2e', email: 'e2e@murmur.test', name: 'E2E Tester' })

  it('is off without the variable', () => {
    expect(resolveTestAuth({}, token, true)).toBeNull()
  })

  it('signs a development build in as the token subject', () => {
    expect(resolveTestAuth({ [TEST_AUTH_TOKEN_FILE]: '/tmp/token.jwt' }, token, true)).toEqual({
      tokenFile: '/tmp/token.jwt',
      identity: { userId: 'user_e2e', email: 'e2e@murmur.test', name: 'E2E Tester' }
    })
  })

  it('never applies to packaged builds, nor to a file without a usable token', () => {
    expect(resolveTestAuth({ [TEST_AUTH_TOKEN_FILE]: '/tmp/token.jwt' }, token, false)).toBeNull()
    expect(resolveTestAuth({ [TEST_AUTH_TOKEN_FILE]: '/tmp/token.jwt' }, null, true)).toBeNull()
    expect(
      resolveTestAuth({ [TEST_AUTH_TOKEN_FILE]: '/tmp/token.jwt' }, 'garbage', true)
    ).toBeNull()
  })
})

describe('FileTokenSource', () => {
  it('re-reads the file on every request so tokens can be rotated', async () => {
    let contents = ' first \n'
    const source = new FileTokenSource('/tmp/token.jwt', async () => contents)
    expect(await source.request()).toBe('first')
    contents = 'second'
    expect(await source.request()).toBe('second')
  })

  it('reports no session for an empty or unreadable file', async () => {
    expect(await new FileTokenSource('/tmp/token.jwt', async () => '\n').request()).toBeNull()
    expect(
      await new FileTokenSource('/tmp/token.jwt', async () => {
        throw new Error('ENOENT')
      }).request()
    ).toBeNull()
  })
})

describe('resolveCloudConfig with test auth', () => {
  const identity = { userId: 'user_e2e', email: 'e2e@murmur.test', name: 'E2E Tester' }

  it('enables the cloud without a Clerk key and carries the identity to the renderer', () => {
    const { config, warnings } = resolveCloudConfig(
      { MURMUR_CONVEX_URL: 'http://127.0.0.1:3210' },
      {},
      { testAuth: identity }
    )
    expect(config).toMatchObject({
      accountMode: 'required',
      convexUrl: 'http://127.0.0.1:3210',
      convexSiteUrl: 'http://127.0.0.1:3211',
      clerkPublishableKey: '',
      clerkFrontendApiHost: '',
      testAuth: identity
    })
    expect(warnings).toEqual([expect.stringMatching(/Clerk is bypassed/)])
  })

  it('still needs a Convex URL', () => {
    const { config, warnings } = resolveCloudConfig({}, {}, { testAuth: identity })
    expect(config.accountMode).toBe('off')
    expect(config.testAuth).toBeUndefined()
    expect(warnings[0]).toMatch(/CONVEX_URL/)
  })

  it('leaves the ordinary Clerk configuration untouched when absent', () => {
    const key = `pk_live_${Buffer.from('clerk.murmur.app$').toString('base64')}`
    const { config } = resolveCloudConfig(
      {},
      { convexUrl: 'https://a.convex.cloud', clerkPublishableKey: key },
      { testAuth: null }
    )
    expect(config.clerkFrontendApiHost).toBe('clerk.murmur.app')
    expect(config.clerkPublishableKey).toBe(key)
    expect(config.testAuth).toBeUndefined()
  })
})
