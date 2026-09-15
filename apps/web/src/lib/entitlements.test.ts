import { describe, expect, it } from 'vitest'
import type { InferenceStatus } from './backend-api'
import {
  checkoutOutcome,
  compactCount,
  describeReset,
  displayedMeters,
  exhaustedNotice,
  formatAudioSeconds,
  formatLocalDate,
  formatLongDate,
  meterView,
  planLabel,
  resetPoint,
  trialDaysLeft,
  upgradeIntent,
  usageDayUtc
} from './entitlements'

const MINUTE = 60_000
// Local-time instants, so the expectations hold in whatever zone the tests run.
const NOW = new Date(2026, 8, 13, 12, 0).getTime()
const TOMORROW = new Date(2026, 8, 14).getTime()
const WEDNESDAY = new Date(2026, 8, 16).getTime()
const OCTOBER = new Date(2026, 9, 1).getTime()

type Meter = InferenceStatus['meters'][number]
const meter = (limit: Meter['limit'], used: number, allowed: number, resetsAt: number): Meter => ({
  limit,
  used,
  allowed,
  exceeded: used >= allowed,
  resetsAt
})

function status(partial: Partial<InferenceStatus>): InferenceStatus {
  return {
    available: true,
    models: { stt: 'murmur-transcribe', llm: 'murmur-format' },
    plan: 'free',
    planState: 'free',
    trialEndsAt: null,
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

const pro = (partial: Partial<InferenceStatus>): InferenceStatus =>
  status({ plan: 'pro', planState: 'pro', ...partial })

describe('plan states and dates', () => {
  it('keys the day in UTC and names the states', () => {
    expect(usageDayUtc(Date.UTC(2026, 8, 13, 12, 0))).toBe('2026-09-13')
    expect(usageDayUtc(Date.UTC(2026, 8, 13, 23, 59))).toBe('2026-09-13')
    expect(planLabel('trial')).toBe('Pro trial')
    expect(planLabel('free')).toBe('Free')
    expect(planLabel('pro')).toBe('Pro')
  })

  it('counts trial days left, never below zero', () => {
    expect(trialDaysLeft(NOW + 14 * 86_400_000, NOW)).toBe(14)
    expect(trialDaysLeft(NOW + 1000, NOW)).toBe(1)
    expect(trialDaysLeft(NOW - 1000, NOW)).toBe(0)
  })

  it("describes resets in the viewer's time zone, the apps' way", () => {
    expect(describeReset(NOW + 30_000, NOW)).toBe('in a moment')
    expect(describeReset(NOW - 1, NOW)).toBe('in a moment')
    expect(describeReset(NOW + 40 * MINUTE, NOW)).toBe('in 40 min')
    expect(describeReset(new Date(2026, 8, 13, 15, 0).getTime(), NOW)).toBe('at 3:00 pm')
    expect(describeReset(new Date(2026, 8, 14, 1, 0).getTime(), NOW)).toBe('tomorrow at 1:00 am')
    expect(describeReset(TOMORROW, NOW)).toBe('tomorrow at 12:00 am')
    expect(describeReset(WEDNESDAY, NOW)).toBe('Wed 16 Sep')
    expect(describeReset(new Date(2026, 8, 25).getTime(), NOW)).toBe('on 25 Sep')
    expect(resetPoint(new Date(2026, 8, 25).getTime(), NOW)).toBe('25 Sep')
    expect(resetPoint(WEDNESDAY, NOW)).toBe('Wed 16 Sep')
    expect(formatLocalDate(OCTOBER)).toBe('Thu 1 Oct')
    expect(formatLongDate(Date.UTC(2026, 9, 13))).toBe('13 October 2026')
  })
})

describe('figures', () => {
  it("prints tokens and audio as the apps' meters do", () => {
    expect(compactCount(900)).toBe('900')
    expect(compactCount(12_000)).toBe('12k')
    expect(compactCount(500_000)).toBe('500k')
    expect(compactCount(2_100_000)).toBe('2.1M')
    expect(compactCount(25_000_000)).toBe('25M')
    expect(formatAudioSeconds(420)).toBe('7 min')
    expect(formatAudioSeconds(7200)).toBe('120 min')
    expect(formatAudioSeconds(108_000)).toBe('30 h')
    expect(formatAudioSeconds(30, 420)).toBe('<1 min')
    expect(formatAudioSeconds(9000, 108_000)).toBe('2.5 h')
  })
})

describe('meters', () => {
  const FREE_METERS = [
    meter('wordsPerWeek', 312, 500, WEDNESDAY),
    meter('sttSecondsPerWeek', 240, 420, TOMORROW),
    meter('dictationsPerDay', 3, 12, TOMORROW),
    meter('sttSecondsPerMonth', 240, 7200, OCTOBER),
    meter('llmTokensPerMonth', 900, 500_000, OCTOBER),
    meter('maxClipSeconds', 0, 60, NOW),
    meter('requestsPerMinute', 0, 20, NOW)
  ]

  it('shows every allowance that fills up, in the backend order, like the apps', () => {
    const free = status({ meters: FREE_METERS })
    expect(displayedMeters(free).map((m) => m.limit)).toEqual([
      'wordsPerWeek',
      'sttSecondsPerWeek',
      'dictationsPerDay',
      'sttSecondsPerMonth',
      'llmTokensPerMonth'
    ])
    const views = displayedMeters(free).map(meterView)
    expect(views[0]).toMatchObject({
      label: 'Words, last 7 days',
      display: '312 of 500',
      ratio: 0.624,
      exceeded: false
    })
    expect(views[1]).toMatchObject({ label: 'Audio, last 7 days', display: '4 of 7 min' })
    expect(views[2]).toMatchObject({ label: 'Dictations today', display: '3 of 12' })
    expect(views[3]).toMatchObject({ label: 'Audio this month', display: '4 of 120 min' })
    expect(views[4]).toMatchObject({
      label: 'Formatting tokens this month',
      display: '900 of 500k'
    })

    const paid = pro({
      meters: [
        meter('fairUseSttSecondsPerMonth', 7200, 108_000, OCTOBER),
        meter('sttSecondsPerMonth', 7200, 216_000, OCTOBER),
        meter('llmTokensPerMonth', 61_000, 25_000_000, OCTOBER),
        meter('maxClipSeconds', 0, 600, NOW),
        meter('requestsPerMinute', 0, 60, NOW)
      ]
    })
    expect(
      displayedMeters(paid)
        .map(meterView)
        .map((m) => m.display)
    ).toEqual(['2 of 30 h', '2 of 60 h', '61k of 25M'])
    expect(meterView(meter('wordsPerWeek', 600, 500, TOMORROW))).toMatchObject({
      ratio: 1,
      exceeded: true
    })
  })

  it("says which limit ran out, in the apps' words and the viewer's time", () => {
    expect(exhaustedNotice(status({}), NOW)).toBeNull()
    expect(exhaustedNotice(status({ meters: FREE_METERS }), NOW)).toBeNull()
    expect(
      exhaustedNotice(status({ meters: [meter('wordsPerWeek', 500, 500, WEDNESDAY)] }), NOW)
    ).toBe("This week's free words are used up (500 words a week on the free plan); more Wed 16 Sep.")
    expect(
      exhaustedNotice(status({ meters: [meter('sttSecondsPerWeek', 420, 420, TOMORROW)] }), NOW)
    ).toBe(
      "This week's free minutes are used up (7 min of speech a week on the free plan); more tomorrow at 12:00 am."
    )
    expect(
      exhaustedNotice(status({ meters: [meter('dictationsPerDay', 12, 12, TOMORROW)] }), NOW)
    ).toBe(
      "Today's free dictations are used up (12 dictations a day on the free plan); more tomorrow at 12:00 am."
    )
  })

  it("covers the month's transcription and formatting allowances for every tier", () => {
    expect(
      exhaustedNotice(status({ meters: [meter('sttSecondsPerMonth', 7200, 7200, OCTOBER)] }), NOW)
    ).toBe(
      "Transcription is paused until 1 Oct: this month's 120 min of Murmur transcription are used up; dictations are refused until then. Connect your own provider under Models to keep dictating, or upgrade for unlimited dictation."
    )
    expect(
      exhaustedNotice(pro({ meters: [meter('sttSecondsPerMonth', 216_000, 216_000, OCTOBER)] }), NOW)
    ).toBe(
      "Transcription is paused until 1 Oct: this month's 60 h of Murmur transcription are used up (fair use); dictations are refused until then. Connect your own provider under Models to keep dictating."
    )
    expect(
      exhaustedNotice(
        status({ meters: [meter('llmTokensPerMonth', 500_000, 500_000, OCTOBER)] }),
        NOW
      )
    ).toBe(
      "This month's formatting allowance is used up (500k tokens a month on the free plan); until 1 Oct Murmur inserts your words with rule-based cleanup only."
    )
    expect(
      exhaustedNotice(
        pro({ meters: [meter('llmTokensPerMonth', 25_000_000, 25_000_000, OCTOBER)] }),
        NOW
      )
    ).toBe(
      "This month's formatting allowance is used up (25M tokens a month on Pro); until 1 Oct Murmur inserts your words with rule-based cleanup only."
    )
    expect(
      exhaustedNotice(
        pro({
          formattingPaused: true,
          meters: [meter('fairUseSttSecondsPerMonth', 108_000, 108_000, OCTOBER)]
        }),
        NOW
      )
    ).toBe(
      'Formatting is paused until 1 Oct: past 30 h of transcription this month, Murmur inserts your words with rule-based cleanup only (fair use). Nothing else changes.'
    )
  })

  it('lets stopped transcription outrank the week, and the week outrank formatting', () => {
    const both = status({
      meters: [
        meter('wordsPerWeek', 500, 500, WEDNESDAY),
        meter('sttSecondsPerMonth', 7200, 7200, OCTOBER),
        meter('llmTokensPerMonth', 500_000, 500_000, OCTOBER)
      ]
    })
    expect(exhaustedNotice(both, NOW)).toMatch(/^Transcription is paused/)
    const weekAndTokens = status({
      meters: [
        meter('wordsPerWeek', 500, 500, WEDNESDAY),
        meter('llmTokensPerMonth', 500_000, 500_000, OCTOBER)
      ]
    })
    expect(exhaustedNotice(weekAndTokens, NOW)).toMatch(/^This week's free words/)
  })
})

describe('URL parameters', () => {
  it('reads the upgrade intent and the checkout outcome', () => {
    expect(upgradeIntent(null)).toBeNull()
    expect(upgradeIntent('yearly')).toBe('year')
    expect(upgradeIntent('monthly')).toBe('month')
    expect(upgradeIntent('1')).toBe('year')
    expect(checkoutOutcome('success')).toBe('success')
    expect(checkoutOutcome('cancelled')).toBe('cancelled')
    expect(checkoutOutcome('other')).toBeNull()
    expect(checkoutOutcome(null)).toBeNull()
  })
})
