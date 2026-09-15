import type { InferenceStatus } from '@/lib/backend-api'
import { formatNumber } from '@/lib/format'

/**
 * The account page's reading of the backend's entitlement contract (packages/backend/convex/lib/
 * entitlements.ts): plan states, the meters and when they reset. The figures and sentences are
 * the apps' (apps/desktop/src/shared/limits.ts, mirrored in the Android Limits.kt), so an account
 * reads the same on the web as on the device that hit the limit. Pure, so the copy is testable.
 */

export type PlanState = InferenceStatus['planState']
export type Meter = InferenceStatus['meters'][number]
export type LimitName = Meter['limit']
export type BillingInterval = 'month' | 'year'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY_MS = 86_400_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The UTC calendar day the backend keys daily usage by, as `YYYY-MM-DD`. */
export function usageDayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function planLabel(state: PlanState): string {
  return state === 'trial' ? 'Pro trial' : state === 'pro' ? 'Pro' : 'Free'
}

/** Whole days left in the trial, never negative. */
export function trialDaysLeft(trialEndsAt: number, now: number): number {
  return Math.max(0, Math.ceil((trialEndsAt - now) / DAY_MS))
}

// ---- dates and times, in the viewer's time zone ---------------------------------------------
//
// The gateway's instants are UTC-aligned (midnight UTC, the first of the month UTC), which is
// some other hour wherever the viewer sits. Everything below formats them in local time, as the
// apps do, and only runs in the browser: the plan card renders these after the account's status
// arrives, never during prerendering.

function clockTime(d: Date): string {
  const h = d.getHours()
  const suffix = h < 12 ? 'am' : 'pm'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(d.getMinutes()).padStart(2, '0')} ${suffix}`
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** `Tue 16 Sep`, the viewer's day. */
export function formatLocalDate(ts: number): string {
  const d = new Date(ts)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** `16 September 2026`, for billing dates (Stripe's period ends, kept in UTC like its invoices). */
export function formatLongDate(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(ts))
}

/**
 * When a meter next moves, the way the apps say it (`formatResetTime`): "in a moment",
 * "in 40 min", "at 3:00 pm", "tomorrow at 1:00 am", "Tue 16 Sep" within the week, "on 25 Sep"
 * beyond it. Reads after "more": "more at 3:00 pm", "more on 25 Sep".
 */
export function describeReset(resetsAt: number, now: number): string {
  const diff = resetsAt - now
  if (diff < MINUTE) return 'in a moment'
  if (diff < HOUR) return `in ${Math.ceil(diff / MINUTE)} min`
  const then = new Date(resetsAt)
  const today = new Date(now)
  if (sameLocalDay(then, today)) return `at ${clockTime(then)}`
  if (sameLocalDay(then, new Date(now + DAY_MS))) return `tomorrow at ${clockTime(then)}`
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`
  return diff < 6 * DAY_MS ? `${WEEKDAYS[then.getDay()]} ${date}` : `on ${date}`
}

/** `describeReset` without its leading "on", to follow "Resets" or "until". */
export function resetPoint(resetsAt: number, now: number): string {
  const reset = describeReset(resetsAt, now)
  return reset.startsWith('on ') ? reset.slice(3) : reset
}

// ---- figures, as the apps print them --------------------------------------------------------

/** Token counts read in thousands and millions: "12k", "500k", "2.1M", "25M". */
export function compactCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  return formatNumber(Math.round(n))
}

/** Seconds of audio in the unit the allowance is naturally read in: minutes, or hours from 3 h up. */
function audioFigure(seconds: number, allowedSeconds: number): { value: string; unit: string } {
  const hours = allowedSeconds >= 3 * 3600 && allowedSeconds % 3600 === 0
  if (hours) {
    const h = seconds / 3600
    const value = h >= 10 || Number.isInteger(h) ? Math.round(h).toString() : h.toFixed(1)
    return { value, unit: 'h' }
  }
  const m = seconds / 60
  return { value: m > 0 && m < 1 ? '<1' : Math.round(m).toString(), unit: 'min' }
}

/** "7 min", "120 min", "30 h"; `allowedSeconds` decides the unit when a used figure is shown against it. */
export function formatAudioSeconds(seconds: number, allowedSeconds = seconds): string {
  const { value, unit } = audioFigure(seconds, allowedSeconds)
  return `${value} ${unit}`
}

// ---- meters ---------------------------------------------------------------------------------

const METER_LABELS: Record<LimitName, string> = {
  wordsPerWeek: 'Words, last 7 days',
  sttSecondsPerWeek: 'Audio, last 7 days',
  dictationsPerDay: 'Dictations today',
  maxClipSeconds: 'Clip length',
  sttSecondsPerMonth: 'Audio this month',
  fairUseSttSecondsPerMonth: 'Audio this month, fair use',
  llmTokensPerMonth: 'Formatting tokens this month',
  requestsPerMinute: 'Requests a minute'
}

/**
 * The meters worth a bar on the account page: every allowance that fills up over time, in the
 * order the backend lists them, exactly the rows the apps' Account pages show. The clip and rate
 * limits are per request and have no fill.
 */
export function displayedMeters(status: InferenceStatus): Meter[] {
  return status.meters.filter(
    (m) => m.limit !== 'maxClipSeconds' && m.limit !== 'requestsPerMinute'
  )
}

export interface MeterView {
  limit: LimitName
  label: string
  used: number
  allowed: number
  display: string
  ratio: number
  exceeded: boolean
  resetsAt: number
}

/** "312 of 500", "3 of 7 min", "2.5 of 30 h", "61k of 500k": the apps' `meterValue`. */
export function meterView(meter: Meter): MeterView {
  let display: string
  switch (meter.limit) {
    case 'sttSecondsPerWeek':
    case 'sttSecondsPerMonth':
    case 'fairUseSttSecondsPerMonth':
      display = `${audioFigure(meter.used, meter.allowed).value} of ${formatAudioSeconds(meter.allowed)}`
      break
    case 'llmTokensPerMonth':
      display = `${compactCount(meter.used)} of ${compactCount(meter.allowed)}`
      break
    default:
      display = `${formatNumber(Math.round(meter.used))} of ${formatNumber(meter.allowed)}`
  }
  return {
    limit: meter.limit,
    label: METER_LABELS[meter.limit],
    used: meter.used,
    allowed: meter.allowed,
    display,
    ratio: meter.allowed > 0 ? Math.min(1, meter.used / meter.allowed) : 0,
    exceeded: meter.exceeded,
    resetsAt: meter.resetsAt
  }
}

/**
 * The sentence for an allowance that has run out, in the apps' words (`describeStop` and the
 * Account page's banners). Transcription that has stopped outranks everything: nothing is
 * inserted at all. Then the free week and day, then formatting, which never loses text.
 */
export function exhaustedNotice(status: InferenceStatus, now: number): string | null {
  const by = (limit: LimitName): Meter | undefined => status.meters.find((m) => m.limit === limit)
  const pro = status.plan === 'pro'
  const tier = pro ? 'on Pro' : 'on the free plan'

  const month = by('sttSecondsPerMonth')
  if (month?.exceeded)
    return `Transcription is paused until ${resetPoint(month.resetsAt, now)}: this month's ${formatAudioSeconds(month.allowed)} of Murmur transcription are used up${pro ? ' (fair use)' : ''}; dictations are refused until then. Connect your own provider under Models to keep dictating${pro ? '.' : ', or upgrade for unlimited dictation.'}`
  const words = by('wordsPerWeek')
  if (words?.exceeded)
    return `This week's free words are used up (${formatNumber(words.allowed)} words a week ${tier}); more ${describeReset(words.resetsAt, now)}.`
  const audio = by('sttSecondsPerWeek')
  if (audio?.exceeded)
    return `This week's free minutes are used up (${formatAudioSeconds(audio.allowed)} of speech a week ${tier}); more ${describeReset(audio.resetsAt, now)}.`
  const day = by('dictationsPerDay')
  if (day?.exceeded)
    return `Today's free dictations are used up (${formatNumber(day.allowed)} dictations a day ${tier}); more ${describeReset(day.resetsAt, now)}.`
  const tokens = by('llmTokensPerMonth')
  if (tokens?.exceeded)
    return `This month's formatting allowance is used up (${compactCount(tokens.allowed)} tokens a month ${tier}); until ${resetPoint(tokens.resetsAt, now)} Murmur inserts your words with rule-based cleanup only.`
  if (status.formattingPaused) {
    const soft = by('fairUseSttSecondsPerMonth')
    return `Formatting is paused${soft ? ` until ${resetPoint(soft.resetsAt, now)}` : ' for the rest of this month'}: past ${soft ? formatAudioSeconds(soft.allowed) : '30 h'} of transcription this month, Murmur inserts your words with rule-based cleanup only (fair use). Nothing else changes.`
  }
  return null
}

// ---- URL parameters the account page reacts to ----------------------------------------------

/** `?upgrade=yearly|monthly|1` from the pricing page or a limit error's upgrade URL. */
export function upgradeIntent(value: string | null): BillingInterval | null {
  if (value === null) return null
  if (value === 'monthly' || value === 'month') return 'month'
  return 'year'
}

/** `?checkout=success|cancelled` from Stripe's return URLs. */
export function checkoutOutcome(value: string | null): 'success' | 'cancelled' | null {
  return value === 'success' || value === 'cancelled' ? value : null
}
