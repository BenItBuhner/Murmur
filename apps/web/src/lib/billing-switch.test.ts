import { describe, expect, it } from 'vitest'
import { planFact, privacySections } from '@/app/privacy/page'
import { termsSections } from '@/app/terms/page'
import { heroNote } from '@/components/landing/hero'
import type { InferenceStatus } from './backend-api'
import { planCardHead } from './entitlements'
import { readBillingFlag } from './env'
import { navLinks, productLinks, sitemapPages } from './site'

/** Words that sell or name the paid tier; none may appear in copy the site shows with billing off. */
const PRICING_WORDS =
  /\b(free|card|price|pricing|trial|Pro|Stripe|subscription|upgrade|refund)\b|\$/i

function status(partial: Partial<InferenceStatus> = {}): InferenceStatus {
  return {
    available: true,
    models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
    speedModes: ['normal'],
    plan: 'free',
    planState: 'free',
    trialEndsAt: null,
    billingEnabled: false,
    limits: {
      sttSecondsPerMonth: 7200,
      llmTokensPerMonth: 500_000,
      requestsPerMinute: 20,
      maxClipSeconds: 60
    },
    usage: { period: '2026-09', sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 },
    formattingPaused: false,
    upgradeUrl: null,
    accountUrl: null,
    window: null,
    meters: [],
    resets: null,
    ...partial
  }
}

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

  it('describe the stored access state without a trial or a Pro while off', () => {
    const off = planFact(false)
    expect(off.term).toBe('Access')
    expect(off.detail).not.toMatch(PRICING_WORDS)
    expect(off.detail).toMatch(/access state the instance records/)
    expect(off.detail).toMatch(/private testing/)
    // On, today's row.
    const on = planFact(true)
    expect(on.term).toBe('Plan')
    expect(on.detail).toMatch(/^Trial, free or Pro, when the trial ends, your Stripe customer id/)
    // The row is the one the account section renders, in both shapes.
    for (const selling of [true, false]) {
      const account = privacySections(selling).find((s) => s.id === 'account')
      expect(JSON.stringify(account?.body)).toContain(JSON.stringify(planFact(selling).detail))
    }
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

describe('landing hero', () => {
  it('drops the pricing pitch under the buttons while off', () => {
    expect(heroNote(true)).toBe('Free to start, no card.')
    expect(heroNote(false)).toBe('Bring your own model, or sign in for Murmur’s.')
    expect(heroNote(false)).not.toMatch(PRICING_WORDS)
  })
})

describe('account page plan card', () => {
  it('opens with the label it keeps while the status is on its way, by the site’s own switch', () => {
    expect(planCardHead(null, false)).toEqual({
      selling: false,
      eyebrow: 'Murmur’s models',
      title: '…',
      loading: 'Checking your account…'
    })
    // On, today's loading card.
    expect(planCardHead(null, true)).toEqual({
      selling: true,
      eyebrow: 'Plan',
      title: '…',
      loading: 'Waiting for your account status…'
    })
  })

  it('follows the instance’s switch once the status is here, whatever the site was built with', () => {
    expect(planCardHead(status({ billingEnabled: false }), true)).toEqual({
      selling: false,
      eyebrow: 'Murmur’s models',
      title: 'Included with your account',
      loading: null
    })
    expect(
      planCardHead(status({ billingEnabled: true, plan: 'pro', planState: 'trial' }), false)
    ).toEqual({
      selling: true,
      eyebrow: 'Plan',
      title: 'Pro trial',
      loading: null
    })
    // The private-testing states are named whatever the switch says.
    expect(planCardHead(status({ plan: 'testing', planState: 'testing' }), false).title).toBe(
      'Private testing'
    )
    expect(planCardHead(status({ plan: 'unlimited', planState: 'unlimited' }), false).title).toBe(
      'Unlimited'
    )
    // An instance from before the switch sells Pro.
    const { billingEnabled: _legacy, ...older } = status()
    expect(planCardHead(older as InferenceStatus, false).eyebrow).toBe('Plan')
  })
})
