import { describe, expect, it } from 'vitest'
import {
  deriveConvexSiteUrl,
  frontendApiFromPublishableKey,
  resolveCloudConfig
} from '../src/main/cloud/config'
import { buildRendererCsp } from '../src/main/cloud/csp'

// base64("clerk.murmur.app$") / base64("bright-otter-12.clerk.accounts.dev$")
const LIVE_KEY = `pk_live_${Buffer.from('clerk.murmur.app$').toString('base64')}`
const TEST_KEY = `pk_test_${Buffer.from('bright-otter-12.clerk.accounts.dev$').toString('base64')}`

describe('frontendApiFromPublishableKey', () => {
  it('decodes the Frontend API host', () => {
    expect(frontendApiFromPublishableKey(LIVE_KEY)).toBe('clerk.murmur.app')
    expect(frontendApiFromPublishableKey(TEST_KEY)).toBe('bright-otter-12.clerk.accounts.dev')
  })

  it('rejects anything that is not a Clerk publishable key', () => {
    expect(frontendApiFromPublishableKey('')).toBeNull()
    expect(frontendApiFromPublishableKey('sk_live_abc')).toBeNull()
    expect(frontendApiFromPublishableKey('pk_live_!!!')).toBeNull()
    expect(
      frontendApiFromPublishableKey(`pk_live_${Buffer.from('not a host').toString('base64')}`)
    ).toBeNull()
  })
})

describe('resolveCloudConfig', () => {
  it('is local (off) when nothing is configured', () => {
    const { config, warnings } = resolveCloudConfig({}, {})
    expect(config.accountMode).toBe('off')
    expect(config.deepLinkScheme).toBe('murmur')
    expect(warnings).toEqual([])
  })

  it('requires an account by default when a Convex URL and Clerk key are present', () => {
    const { config, warnings } = resolveCloudConfig(
      {},
      { convexUrl: 'https://happy-otter-123.convex.cloud/', clerkPublishableKey: LIVE_KEY }
    )
    expect(config).toMatchObject({
      accountMode: 'required',
      convexUrl: 'https://happy-otter-123.convex.cloud',
      convexSiteUrl: 'https://happy-otter-123.convex.site',
      clerkFrontendApiHost: 'clerk.murmur.app',
      jwtTemplate: 'convex'
    })
    expect(warnings).toEqual([])
  })

  it('derives the HTTP actions origin for the managed-model gateway, or takes an explicit one', () => {
    expect(deriveConvexSiteUrl('https://happy-otter-123.convex.cloud')).toBe(
      'https://happy-otter-123.convex.site'
    )
    expect(deriveConvexSiteUrl('http://127.0.0.1:3210')).toBe('http://127.0.0.1:3211')
    expect(deriveConvexSiteUrl('https://convex.example.com')).toBeNull()
    expect(deriveConvexSiteUrl('nope')).toBeNull()

    const local = resolveCloudConfig(
      { MURMUR_CONVEX_URL: 'http://127.0.0.1:3210', MURMUR_CLERK_PUBLISHABLE_KEY: TEST_KEY },
      {}
    )
    expect(local.config.convexSiteUrl).toBe('http://127.0.0.1:3211')

    const explicit = resolveCloudConfig(
      { MURMUR_CONVEX_SITE_URL: 'https://api.murmur.example/' },
      { convexUrl: 'https://convex.murmur.example', clerkPublishableKey: LIVE_KEY }
    )
    expect(explicit.config.convexSiteUrl).toBe('https://api.murmur.example')
    expect(explicit.warnings).toEqual([])

    const underivable = resolveCloudConfig(
      {},
      { convexUrl: 'https://convex.murmur.example', clerkPublishableKey: LIVE_KEY }
    )
    expect(underivable.config.accountMode).toBe('required')
    expect(underivable.config.convexSiteUrl).toBe('')
    expect(underivable.warnings[0]).toMatch(/MURMUR_CONVEX_SITE_URL/)

    const bad = resolveCloudConfig(
      { MURMUR_CONVEX_SITE_URL: 'ftp://nope' },
      { convexUrl: 'https://a.convex.cloud', clerkPublishableKey: LIVE_KEY }
    )
    expect(bad.config.convexSiteUrl).toBe('https://a.convex.site')
    expect(bad.warnings[0]).toMatch(/not an http\(s\) URL/)
  })

  it('lets the build or environment choose optional mode, and env wins over build values', () => {
    const build = {
      convexUrl: 'https://a.convex.cloud',
      clerkPublishableKey: LIVE_KEY,
      accountMode: 'optional'
    }
    expect(resolveCloudConfig({}, build).config.accountMode).toBe('optional')
    const overridden = resolveCloudConfig(
      {
        MURMUR_CONVEX_URL: 'http://127.0.0.1:3210',
        MURMUR_CLERK_PUBLISHABLE_KEY: TEST_KEY,
        MURMUR_ACCOUNT_MODE: 'required'
      },
      build
    ).config
    expect(overridden).toMatchObject({
      accountMode: 'required',
      convexUrl: 'http://127.0.0.1:3210',
      clerkFrontendApiHost: 'bright-otter-12.clerk.accounts.dev'
    })
  })

  it('falls back to local mode with a warning when a key is missing or malformed', () => {
    const noKey = resolveCloudConfig({}, { convexUrl: 'https://a.convex.cloud' })
    expect(noKey.config.accountMode).toBe('off')
    expect(noKey.warnings[0]).toMatch(/publishable key/)
    const badUrl = resolveCloudConfig(
      {},
      { convexUrl: 'ftp://nope', clerkPublishableKey: LIVE_KEY }
    )
    expect(badUrl.config.accountMode).toBe('off')
    expect(badUrl.warnings[0]).toMatch(/CONVEX_URL/)
    const badMode = resolveCloudConfig(
      {},
      { convexUrl: 'https://a.convex.cloud', clerkPublishableKey: LIVE_KEY, accountMode: 'maybe' }
    )
    expect(badMode.config.accountMode).toBe('required')
    expect(badMode.warnings[0]).toMatch(/Unknown account mode/)
  })

  it('MURMUR_ACCOUNT_MODE=off forces local mode even when keys are present', () => {
    const { config } = resolveCloudConfig(
      { MURMUR_ACCOUNT_MODE: 'off' },
      { convexUrl: 'https://a.convex.cloud', clerkPublishableKey: LIVE_KEY }
    )
    expect(config.accountMode).toBe('off')
    expect(config.convexUrl).toBe('')
  })

  it('validates a custom deep link scheme', () => {
    expect(
      resolveCloudConfig({ MURMUR_DEEP_LINK_SCHEME: 'murmur-dev' }, {}).config.deepLinkScheme
    ).toBe('murmur-dev')
    const bad = resolveCloudConfig({ MURMUR_DEEP_LINK_SCHEME: '9bad scheme' }, {})
    expect(bad.config.deepLinkScheme).toBe('murmur')
    expect(bad.warnings[0]).toMatch(/deep link scheme/)
  })
})

describe('buildRendererCsp', () => {
  it('only opens Clerk hosts when a cloud instance is configured', () => {
    const local = buildRendererCsp({ dev: false })
    expect(local).toContain("default-src 'self'")
    expect(local).not.toContain('clerk')
    expect(local).not.toContain('unsafe-eval')

    const cloud = buildRendererCsp({ clerkFrontendApiHost: 'clerk.murmur.app', dev: false })
    expect(cloud).toMatch(/script-src [^;]*https:\/\/clerk\.murmur\.app/)
    expect(cloud).toMatch(/connect-src [^;]*https:\/\/clerk\.murmur\.app/)
    expect(cloud).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/)

    const dev = buildRendererCsp({ dev: true })
    expect(dev).toMatch(/script-src [^;]*'unsafe-eval'/)
    expect(dev).toMatch(/connect-src [^;]*ws:\/\/localhost:\*/)
    // The overlay's AudioWorklet module is a blob: URL and only the dev build serves it under the CSP.
    expect(dev).toMatch(/script-src [^;]*blob:/)
    expect(local).not.toMatch(/script-src [^;]*blob:/)
  })
})
