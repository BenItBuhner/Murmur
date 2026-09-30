import { describe, expect, it } from 'vitest'
import type { InferenceStatus, UsageMeter } from '@shared/cloud'
import type { InferenceView } from '../src/renderer/src/hooks/useInference'
import {
  planDescription,
  planLine,
  planTitle,
  sourceCaption
} from '../src/renderer/src/lib/plan-copy'

/*
 * What the settings pages say about the plan, in the two shapes the instance can be in: selling
 * Pro (today's copy) or not (`billingEnabled` false: no plan named, no trial counted, no upgrade
 * suggested), and the private-testing states, which always say what they are.
 */

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const OCTOBER = Date.UTC(2026, 9, 1)

function status(partial: Partial<InferenceStatus> = {}): InferenceStatus {
  return {
    available: true,
    models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
    plan: 'free',
    limits: {
      sttSecondsPerMonth: 7200,
      llmTokensPerMonth: 500_000,
      requestsPerMinute: 20,
      maxClipSeconds: 60
    },
    usage: { period: '2026-09', sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 },
    meters: [],
    ...partial
  }
}

function view(partial: Partial<InferenceView> = {}): InferenceView {
  const planState = partial.planState ?? 'free'
  const metered = planState !== 'testing' && planState !== 'unlimited'
  return {
    cloudEnabled: true,
    managedAvailable: true,
    offersMurmur: true,
    routing: { stt: 'murmur', llm: 'murmur' },
    signedIn: true,
    status: status({ plan: partial.plan ?? 'free', planState }),
    plan: 'free',
    planState,
    billingEnabled: true,
    metered,
    trialDaysLeft: 0,
    meters: [],
    resets: null,
    upgradeUrl: null,
    accountUrl: null,
    formattingPaused: false,
    sttReady: true,
    llmReady: true,
    minutes: metered ? { used: 0, limit: 120 } : null,
    tokensUsed: 0,
    ...partial
  }
}

const words: UsageMeter = {
  limit: 'wordsPerWeek',
  used: 120,
  allowed: 500,
  exceeded: false,
  resetsAt: OCTOBER
}
const month: UsageMeter = {
  limit: 'sttSecondsPerMonth',
  used: 7200,
  allowed: 7200,
  exceeded: true,
  resetsAt: OCTOBER
}

describe('titles and captions', () => {
  it('name the plan while Pro is sold, the models otherwise, and the testing states always', () => {
    expect(planTitle('trial')).toBe('Pro trial')
    expect(planTitle('free')).toBe('Free plan')
    expect(planTitle('pro')).toBe('Pro plan')
    expect(planTitle('testing')).toBe('Private testing')
    expect(planTitle('unlimited')).toBe('Unlimited')
    expect(sourceCaption(view({ planState: 'trial' }))).toBe('Pro trial')
    expect(sourceCaption(view({ planState: 'pro', billingEnabled: false }))).toBe(
      'Included with your account'
    )
    expect(sourceCaption(view({ planState: 'free', billingEnabled: false }))).toBe(
      'Included with your account'
    )
    expect(sourceCaption(view({ planState: 'testing', billingEnabled: false }))).toBe(
      'Private testing'
    )
    expect(sourceCaption(view({ planState: 'unlimited', billingEnabled: false }))).toBe('Unlimited')
  })
})

describe('the Account page sentence', () => {
  it('sells Pro only while the instance does', () => {
    expect(planDescription(view({ planState: 'trial', trialDaysLeft: 9 }))).toMatch(
      /^9 days left with everything Pro offers.*upgrade whenever/
    )
    expect(
      planDescription(view({ planState: 'trial', trialDaysLeft: 9, billingEnabled: false }))
    ).toBe(
      'Unlimited dictation within fair use: the meters below show how far this month has come.'
    )
    expect(planDescription(view({ planState: 'free' }))).toMatch(/Upgrade for unlimited dictation/)
    const free = planDescription(view({ planState: 'free', billingEnabled: false }))
    expect(free).not.toMatch(/[Uu]pgrade|Pro/)
    expect(free).toMatch(/Connect your own provider under Models/)
    expect(planDescription(view({ planState: 'pro', plan: 'pro' }))).toMatch(
      /Invoices, the card and cancellation/
    )
    expect(planDescription(view({ planState: 'pro', plan: 'pro', billingEnabled: false }))).toBe(
      'Unlimited dictation within fair use: the meters below show how far this month has come.'
    )
  })

  it('says what private testing means for the account, whatever the switch', () => {
    for (const billingEnabled of [true, false]) {
      expect(
        planDescription(view({ planState: 'testing', plan: 'testing', billingEnabled }))
      ).toMatch(
        /^This Murmur server is in private testing: its speech and formatting models are not open to this account yet\./
      )
      expect(
        planDescription(view({ planState: 'unlimited', plan: 'unlimited', billingEnabled }))
      ).toMatch(/on the server's list.*without an allowance to run out of/)
    }
  })

  it('keeps the states that come before the plan', () => {
    expect(planDescription(view({ managedAvailable: false }))).toMatch(
      /does not provide models of its own/
    )
    expect(planDescription(view({ status: null }))).toBe('Waiting for your account status…')
  })
})

describe('the Home line', () => {
  it('counts trial days only while Pro is sold, and never names a plan without one', () => {
    expect(planLine(view({ planState: 'trial', trialDaysLeft: 3 }))).toBe('Pro trial · 3 days left')
    expect(
      planLine(view({ planState: 'trial', trialDaysLeft: 3, billingEnabled: false }))
    ).toBeNull()
    expect(planLine(view({ planState: 'free', meters: [words] }))).toBe(
      'Free plan · 120 of 500 words this week'
    )
    expect(planLine(view({ planState: 'free', meters: [words], billingEnabled: false }))).toBe(
      '120 of 500 words this week'
    )
    expect(planLine(view({ planState: 'pro', plan: 'pro', meters: [month] }))).toMatch(
      /^Pro · transcription paused until/
    )
    expect(
      planLine(view({ planState: 'pro', plan: 'pro', meters: [month], billingEnabled: false }))
    ).toMatch(/^transcription paused until/)
  })

  it('points a testing account at its own provider, and says nothing for an unlimited one', () => {
    expect(planLine(view({ planState: 'testing', plan: 'testing', billingEnabled: false }))).toBe(
      "Murmur's models are in private testing · connect your own under Models"
    )
    // Already on its own provider: nothing to say.
    expect(
      planLine(
        view({ planState: 'testing', plan: 'testing', routing: { stt: 'custom', llm: 'custom' } })
      )
    ).toBeNull()
    expect(planLine(view({ planState: 'unlimited', plan: 'unlimited' }))).toBeNull()
    expect(planLine(view({ signedIn: false }))).toBeNull()
  })
})

// NOW is unused by the copy itself; it pins the fixtures' dates to one day for readers.
void NOW
