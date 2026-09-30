import { describe, expect, it } from 'vitest'
import { privacySections } from '@/app/privacy/page'
import { termsSections } from '@/app/terms/page'
import { readBillingFlag } from './env'
import { navLinks, productLinks, sitemapPages } from './site'

/*
 * The billing switch on the website (`NEXT_PUBLIC_MURMUR_BILLING_ENABLED`): off, nothing on the
 * site sells or mentions Pro; on, today's site. The pricing page itself answers 404 while off
 * (app/pricing/page.tsx calls notFound()), so no link may point at it.
 */

describe('the flag', () => {
  it('is on only for the literal true, like the backend switch', () => {
    expect(readBillingFlag(undefined)).toBe(false)
    expect(readBillingFlag('')).toBe(false)
    expect(readBillingFlag('false')).toBe(false)
    expect(readBillingFlag('1')).toBe(false)
    expect(readBillingFlag('yes')).toBe(false)
    expect(readBillingFlag('true')).toBe(true)
    expect(readBillingFlag(' TRUE ')).toBe(true)
  })
})

describe('links', () => {
  it('drop Pricing from the header, the footer and the sitemap while off', () => {
    expect(navLinks(false).map((l) => l.href)).toEqual(['/#engine', '/download'])
    expect(productLinks(false).map((l) => l.href)).toEqual(['/#engine', '/download', '/account'])
    expect(sitemapPages(false).map((p) => p.path)).toEqual(['/', '/download', '/privacy', '/terms'])
  })

  it('keep today’s site while on', () => {
    expect(navLinks(true).map((l) => l.href)).toEqual(['/#engine', '/pricing', '/download'])
    expect(productLinks(true).map((l) => l.href)).toEqual([
      '/#engine',
      '/pricing',
      '/download',
      '/account'
    ])
    expect(sitemapPages(true).map((p) => p.path)).toEqual([
      '/',
      '/download',
      '/pricing',
      '/privacy',
      '/terms'
    ])
  })
})

describe('legal pages', () => {
  it('leave out the trial, Pro, fair-use and refund sections of the terms while off', () => {
    expect(termsSections(false).map((s) => s.id)).toEqual([
      'scope',
      'account',
      'models',
      'service',
      'liability',
      'changes'
    ])
    expect(termsSections(true).map((s) => s.id)).toEqual([
      'scope',
      'account',
      'trial',
      'free',
      'pro',
      'fair-use',
      'cancel',
      'service',
      'liability',
      'changes'
    ])
  })

  it('leave out the payments section of the privacy page while off', () => {
    const off = privacySections(false).map((s) => s.id)
    const on = privacySections(true).map((s) => s.id)
    expect(off).not.toContain('billing')
    expect(on).toContain('billing')
    expect(on.filter((id) => id !== 'billing')).toEqual(off)
    expect(off).toEqual([
      'short',
      'local',
      'account',
      'models',
      'retention',
      'services',
      'choices',
      'contact'
    ])
  })
})
