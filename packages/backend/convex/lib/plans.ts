import { v, type Infer } from 'convex/values'

/**
 * Account tiers. Every account starts on `free`; `pro` is set by the operator (or a billing
 * integration) through `internal.users.setPlan`. The tier decides how much of the instance's
 * managed inference an account may use each calendar month (UTC) and how fast it may ask.
 */
export const planValidator = v.union(v.literal('free'), v.literal('pro'))
export type Plan = Infer<typeof planValidator>

export interface PlanLimits {
  /** Seconds of audio the managed speech model transcribes per month. */
  sttSecondsPerMonth: number
  /** Prompt + completion tokens the managed formatting model may use per month. */
  llmTokensPerMonth: number
  /** Managed inference requests (speech and formatting together) per rolling minute. */
  requestsPerMinute: number
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: {
    sttSecondsPerMonth: 120 * 60,
    llmTokensPerMonth: 500_000,
    requestsPerMinute: 20
  },
  pro: {
    sttSecondsPerMonth: 100 * 60 * 60,
    llmTokensPerMonth: 25_000_000,
    requestsPerMinute: 60
  }
}

export const DEFAULT_PLAN: Plan = 'free'

export function planLimits(plan: Plan | undefined): PlanLimits {
  return PLANS[plan ?? DEFAULT_PLAN]
}

/**
 * A single clip the gateway accepts, in seconds. Convex HTTP actions cap request bodies at 20 MB,
 * which is roughly ten minutes of 16 kHz 16-bit mono WAV; the limit is slightly below that so the
 * client gets a readable error instead of a transport failure.
 */
export const MAX_CLIP_SECONDS = 600

/** Length of the request-rate window. */
export const RATE_WINDOW_MS = 60_000

/** Calendar month (UTC) a usage row belongs to, as `YYYY-MM`. */
export function usagePeriod(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
