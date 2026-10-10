import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx
} from './_generated/server'
import {
  ZERO_MONTH,
  checkFormatting,
  checkRate,
  checkTranscription,
  formattingPaused,
  meterValidator,
  metersFor,
  refusalValidator,
  requestRateFor,
  weekBuckets,
  weekRollsAt,
  type DayUsage,
  type Meter,
  type MonthUsage,
  type UsageSnapshot
} from './lib/entitlements'
import { accessStateOf } from './lib/access'
import { authedQuery } from './lib/functions'
import {
  MURMUR_MODELS,
  accountUrlFor,
  readUpstreams,
  speedModesFor,
  upgradeUrlFor
} from './lib/inference'
import {
  DAY_MS,
  RATE_WINDOW_MS,
  accessStateValidator,
  billingEnabled,
  dayStart,
  isUsageDay,
  legacyLimitFigures,
  nextMonthStart,
  planLimits,
  planValidator,
  shiftDay,
  tierOf,
  usageDay,
  usagePeriod,
  WEEK_DAYS
} from './lib/plans'
import { breakerAfterFailure, breakerOpenFor, retryAfterSeconds } from './lib/upstream'
import { findUserByClerkId, planStateOf, upsertUser } from './lib/users'
import {
  inferenceKindValidator,
  inferenceStatusValidator,
  type InferenceStatus
} from './lib/validators'

/**
 * Account-side view of the managed inference gateway (convex/gateway.ts): which models this
 * instance offers, what the account's tier allows, and how much of it has been used. The rules
 * themselves live in lib/entitlements.ts; this file reads and writes the usage rows around them.
 */

async function monthRow(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  period: string
): Promise<Doc<'inferenceUsage'> | null> {
  return await ctx.db
    .query('inferenceUsage')
    .withIndex('by_user_and_period', (q) => q.eq('userId', userId).eq('period', period))
    .unique()
}

async function dayRows(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  from: string,
  to: string
): Promise<Doc<'inferenceDays'>[]> {
  return await ctx.db
    .query('inferenceDays')
    .withIndex('by_user_and_day', (q) => q.eq('userId', userId).gte('day', from).lte('day', to))
    .collect()
}

const toDayUsage = (row: Doc<'inferenceDays'>): DayUsage => ({
  day: row.day,
  words: row.words,
  sttSeconds: row.sttSeconds,
  dictations: row.dictations,
  formats: row.formats
})

const toMonthUsage = (row: Doc<'inferenceUsage'> | null): MonthUsage =>
  row
    ? {
        sttSeconds: row.sttSeconds,
        sttRequests: row.sttRequests,
        llmTokens: row.llmTokens,
        llmRequests: row.llmRequests
      }
    : ZERO_MONTH

/** The rolling week ending on `day` and the month containing it. */
async function snapshotFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<'users'>,
  day: string
): Promise<UsageSnapshot> {
  const weekStart = shiftDay(day, -(WEEK_DAYS - 1))
  const [days, month] = await Promise.all([
    dayRows(ctx, userId, weekStart, day),
    monthRow(ctx, userId, day.slice(0, 7))
  ])
  return { day, days: days.map(toDayUsage), month: toMonthUsage(month) }
}

/**
 * The instance's managed models and this account's allowance and usage. Pass `day`, the client's
 * current UTC calendar day (`YYYY-MM-DD`), to get the rolling-week and per-day meters; the query
 * takes the day rather than reading the clock so its result is stable and cacheable within a day.
 * During private testing the state is `testing` or `unlimited` and there are no meters to show.
 */
export const status = authedQuery({
  args: { day: v.optional(v.string()) },
  returns: inferenceStatusValidator,
  handler: async (ctx, args): Promise<InferenceStatus> => {
    if (args.day !== undefined && !isUsageDay(args.day))
      throw new Error('"day" must be a UTC calendar day as YYYY-MM-DD')
    const upstreams = readUpstreams(process.env)
    const planState = accessStateOf(
      process.env,
      ctx.user ? planStateOf(ctx.user) : 'free',
      ctx.identity,
      ctx.user?.email
    )
    const plan = tierOf(planState)
    const limits = planLimits(plan)
    const metered = plan !== 'testing' && plan !== 'unlimited'
    // Newest month with any usage; `period` sorts lexicographically, so the index order is enough.
    const latest = ctx.user
      ? await ctx.db
          .query('inferenceUsage')
          .withIndex('by_user_and_period', (q) => q.eq('userId', ctx.user!._id))
          .order('desc')
          .first()
      : null
    const base: InferenceStatus = {
      available: upstreams.stt !== null,
      models: {
        stt: upstreams.stt ? MURMUR_MODELS.stt : null,
        llm: upstreams.llm ? MURMUR_MODELS.llm : null
      },
      speedModes: speedModesFor(upstreams.stt),
      plan,
      planState,
      trialEndsAt: ctx.user?.trialEndsAt ?? null,
      billingEnabled: billingEnabled(process.env),
      limits: legacyLimitFigures(limits),
      usage: latest
        ? {
            period: latest.period,
            sttSeconds: latest.sttSeconds,
            sttRequests: latest.sttRequests,
            llmTokens: latest.llmTokens,
            llmRequests: latest.llmRequests
          }
        : { period: '', ...ZERO_MONTH },
      formattingPaused: false,
      upgradeUrl: upgradeUrlFor(process.env, planState),
      accountUrl: accountUrlFor(process.env),
      window: null,
      meters: [],
      resets: null
    }
    if (args.day === undefined) return base
    const day = args.day
    const snapshot: UsageSnapshot = ctx.user
      ? await snapshotFor(ctx, ctx.user._id, day)
      : { day, days: [], month: ZERO_MONTH }
    const buckets = weekBuckets(day, snapshot.days)
    const today = buckets[buckets.length - 1]
    return {
      ...base,
      formattingPaused: metered && formattingPaused(limits, snapshot.month),
      window: {
        day,
        weekStart: buckets[0].day,
        words: buckets.reduce((acc, b) => acc + b.words, 0),
        sttSeconds: buckets.reduce((acc, b) => acc + b.sttSeconds, 0),
        dictationsToday: Math.max(today.dictations, today.formats)
      },
      // No quota to show for a `testing` account (zero everywhere) or an `unlimited` one.
      meters: metered ? metersFor(limits, snapshot) : [],
      resets: {
        day: dayStart(day) + DAY_MS,
        week: weekRollsAt(buckets),
        month: nextMonthStart(day)
      }
    }
  }
})

/** What `authorize` knows about the provider the request is for (the breaker in lib/upstream.ts). */
const providerStateValidator = v.object({
  /** Unavailable answers in a row so far; the gateway resets it after a good one. */
  failures: v.number(),
  /** Set while the breaker is open: how long a client should wait before asking again. */
  openForSec: v.union(v.number(), v.null())
})

const authorizeResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    userId: v.id('users'),
    plan: planValidator,
    planState: accessStateValidator,
    /** Set when the caller may proceed without the model (Pro past its soft fair-use cap). */
    paused: v.union(meterValidator, v.null()),
    /**
     * The provider's recent health. With `openForSec` set the caller must not ask the provider: a
     * degradable route answers with rule-based text, any other route would have been refused.
     */
    provider: providerStateValidator
  }),
  v.object({
    ok: v.literal(false),
    plan: planValidator,
    planState: accessStateValidator,
    refusal: refusalValidator
  }),
  /** Private testing and the account is not on the list: no allowance, nothing to meter. */
  v.object({
    ok: v.literal(false),
    plan: v.literal('testing'),
    planState: v.literal('testing'),
    denied: v.literal('private_testing')
  }),
  /** The provider's breaker is open: refused before the provider is asked, nothing counted. */
  v.object({
    ok: v.literal(false),
    plan: planValidator,
    planState: accessStateValidator,
    unavailable: v.object({ retryAfterSec: v.number() })
  })
)

async function providerHealthRow(
  ctx: QueryCtx | MutationCtx,
  kind: 'stt' | 'llm'
): Promise<Doc<'providerHealth'> | null> {
  return await ctx.db
    .query('providerHealth')
    .withIndex('by_kind', (q) => q.eq('kind', kind))
    .unique()
}

/** The session claims the gateway forwards so the private-testing list can judge the account. */
const identityArgs = {
  clerkId: v.string(),
  email: v.optional(v.string()),
  emailVerified: v.optional(v.boolean())
}

/**
 * Where the account stands for `/v1/models`, which lists models without gating a request: the
 * same answer `authorize` would give, without provisioning or counting anything.
 */
export const access = internalQuery({
  args: identityArgs,
  returns: accessStateValidator,
  handler: async (ctx, args) => {
    const user = await findUserByClerkId(ctx, args.clerkId)
    return accessStateOf(process.env, user ? planStateOf(user) : 'free', args, user?.email)
  }
})

/**
 * Gate one managed request. Provisions the account row if the Clerk webhook has not created it yet
 * (which also starts its trial), settles a trial that has run out, refuses a `testing` account
 * outright, refuses when a limit of the tier is reached or the account is asking too fast, and
 * otherwise counts the request against the rate window. Usage itself is added by `record` once the
 * upstream answered, so a failed request never costs allowance.
 */
export const authorize = internalMutation({
  args: {
    ...identityArgs,
    kind: inferenceKindValidator,
    /** Clip length for speech requests, so a request that cannot fit is refused up front. */
    seconds: v.optional(v.number()),
    /** The caller can answer with rule-based text instead of failing (/v1/format). */
    degradable: v.optional(v.boolean())
  },
  returns: authorizeResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    // The token's email travels with the request so an account the gateway provisions first (before
    // `users.ensure` ran) is judged by it, not by an empty row.
    const user = await upsertUser(ctx, args.clerkId, { email: args.email }, now)
    const planState = accessStateOf(process.env, planStateOf(user), args, user.email)
    if (planState === 'testing')
      return { ok: false as const, plan: 'testing' as const, planState, denied: 'private_testing' as const }
    const plan = tierOf(planState)
    const limits = planLimits(plan)
    const day = usageDay(now)
    const period = usagePeriod(now)
    const [snapshot, usage] = await Promise.all([
      snapshotFor(ctx, user._id, day),
      monthRow(ctx, user._id, period)
    ])
    const check = { plan, state: planState, limits, snapshot, now }

    let paused: Meter | null = null
    if (args.kind === 'stt') {
      const refusal = checkTranscription(check, Math.max(0, args.seconds ?? 0))
      if (refusal) return { ok: false as const, plan, planState, refusal }
    } else {
      const verdict = checkFormatting(check, args.degradable === true)
      if (!verdict.ok) return { ok: false as const, plan, planState, refusal: verdict.refusal }
      paused = verdict.paused
    }

    const windowFresh = usage?.windowStart !== undefined && now - usage.windowStart < RATE_WINDOW_MS
    const windowStart = windowFresh ? usage!.windowStart! : now
    const windowCount = windowFresh ? (usage!.windowCount ?? 0) : 0
    const rate = checkRate(requestRateFor(limits, snapshot.month), windowStart, windowCount, now)
    if (rate) return { ok: false as const, plan, planState, refusal: rate }

    // The provider's breaker (lib/upstream.ts): while it is open the provider is not asked. A
    // route that can answer without the model goes on and says so; any other is refused here,
    // before the request counts against the rate window it never used.
    const health = await providerHealthRow(ctx, args.kind)
    const openMs = health ? breakerOpenFor({ failures: health.failures, openUntil: health.openUntil ?? null }, now) : null
    const provider = { failures: health?.failures ?? 0, openForSec: openMs === null ? null : retryAfterSeconds(openMs) }
    if (provider.openForSec !== null && args.degradable !== true)
      return { ok: false as const, plan, planState, unavailable: { retryAfterSec: provider.openForSec } }

    if (usage) {
      await ctx.db.patch('inferenceUsage', usage._id, {
        windowStart,
        windowCount: windowCount + 1,
        updatedAt: now
      })
    } else {
      await ctx.db.insert('inferenceUsage', {
        userId: user._id,
        period,
        ...ZERO_MONTH,
        windowStart,
        windowCount: 1,
        updatedAt: now
      })
    }
    return { ok: true as const, userId: user._id, plan, planState, paused, provider }
  }
})

/**
 * The provider answered `provider_unavailable`-style (timed out, unreachable, or a 502/503/504):
 * one more failure in a row, and from the third the breaker opens for the cooldown. Returns the
 * state after, for the gateway's log line and its `Retry-After`.
 */
export const providerFailed = internalMutation({
  args: {
    kind: inferenceKindValidator,
    reason: v.union(v.literal('timeout'), v.literal('unreachable'), v.literal('unavailable'))
  },
  returns: providerStateValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const row = await providerHealthRow(ctx, args.kind)
    const next = breakerAfterFailure({ failures: row?.failures ?? 0, openUntil: row?.openUntil ?? null }, now)
    const patch = {
      failures: next.failures,
      openUntil: next.openUntil ?? undefined,
      lastFailureAt: now,
      lastReason: args.reason,
      updatedAt: now
    }
    if (row) await ctx.db.patch('providerHealth', row._id, patch)
    else await ctx.db.insert('providerHealth', { kind: args.kind, ...patch })
    const openMs = breakerOpenFor(next, now)
    return { failures: next.failures, openForSec: openMs === null ? null : retryAfterSeconds(openMs) }
  }
})

/** The provider answered: whatever failures were counted against it are forgotten. */
export const providerRecovered = internalMutation({
  args: { kind: inferenceKindValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await providerHealthRow(ctx, args.kind)
    if (row && (row.failures > 0 || row.openUntil !== undefined))
      await ctx.db.patch('providerHealth', row._id, {
        failures: 0,
        openUntil: undefined,
        updatedAt: Date.now()
      })
    return null
  }
})

interface UsageDelta {
  kind: 'stt' | 'llm'
  seconds: number
  tokens: number
  words: number
  /** Requests this delta stands for (a batch folds several into one). */
  requests: number
}

/** Add usage to the month and day rows of `at`; one read and one write per row. */
async function addUsage(ctx: MutationCtx, userId: Id<'users'>, deltas: UsageDelta[], at: number): Promise<void> {
  if (deltas.length === 0) return
  const period = usagePeriod(at)
  const day = usageDay(at)
  const [usage, [dayRow]] = await Promise.all([monthRow(ctx, userId, period), dayRows(ctx, userId, day, day)])
  const month = { ...toMonthUsage(usage) }
  const days = {
    words: dayRow?.words ?? 0,
    sttSeconds: dayRow?.sttSeconds ?? 0,
    dictations: dayRow?.dictations ?? 0,
    formats: dayRow?.formats ?? 0
  }
  for (const d of deltas) {
    if (d.kind === 'stt') {
      month.sttSeconds += d.seconds
      month.sttRequests += d.requests
      days.words += d.words
      days.sttSeconds += d.seconds
      days.dictations += d.requests
    } else {
      month.llmTokens += d.tokens
      month.llmRequests += d.requests
      days.formats += d.requests
    }
  }
  const now = Date.now()
  if (usage) await ctx.db.patch('inferenceUsage', usage._id, { ...month, updatedAt: now })
  else await ctx.db.insert('inferenceUsage', { userId, period, ...month, updatedAt: now })
  if (dayRow) await ctx.db.patch('inferenceDays', dayRow._id, { ...days, updatedAt: now })
  else await ctx.db.insert('inferenceDays', { userId, day, ...days, updatedAt: now })
}

/** Add what a successful upstream request consumed to the current month and day. */
export const record = internalMutation({
  args: {
    userId: v.id('users'),
    kind: inferenceKindValidator,
    seconds: v.optional(v.number()),
    tokens: v.optional(v.number()),
    /** Words in the transcript the speech model returned. */
    words: v.optional(v.number())
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await addUsage(
      ctx,
      args.userId,
      [
        {
          kind: args.kind,
          seconds: Math.max(0, args.seconds ?? 0),
          tokens: Math.max(0, Math.floor(args.tokens ?? 0)),
          words: Math.max(0, Math.floor(args.words ?? 0)),
          requests: 1
        }
      ],
      Date.now()
    )
    return null
  }
})

/** Largest usage report the inference Worker sends in one call. */
export const USAGE_BATCH_MAX = 500

export const usageRecordValidator = v.object({
  clerkId: v.string(),
  kind: inferenceKindValidator,
  seconds: v.optional(v.number()),
  tokens: v.optional(v.number()),
  words: v.optional(v.number()),
  /** When the request was answered (ms); decides the day and month it counts toward. */
  at: v.number()
})

/**
 * Usage the inference Worker collected over a few minutes, in one call: grouped per account and
 * UTC day, so a busy batch is still two row writes per account-day instead of two per request.
 * Records for accounts that do not exist (purged meanwhile) are dropped.
 */
export const recordBatch = internalMutation({
  args: { records: v.array(usageRecordValidator) },
  returns: v.object({ recorded: v.number(), dropped: v.number() }),
  handler: async (ctx, args) => {
    if (args.records.length > USAGE_BATCH_MAX) throw new Error(`At most ${USAGE_BATCH_MAX} usage records per call`)
    const now = Date.now()
    const groups = new Map<string, { clerkId: string; at: number; deltas: UsageDelta[] }>()
    for (const r of args.records) {
      // A clock far off (or a replay from long ago) still counts, but toward today.
      const at = Number.isFinite(r.at) && Math.abs(now - r.at) < 35 * DAY_MS ? r.at : now
      const key = `${r.clerkId}|${usageDay(at)}`
      const group = groups.get(key) ?? { clerkId: r.clerkId, at, deltas: [] }
      group.deltas.push({
        kind: r.kind,
        seconds: Math.max(0, r.seconds ?? 0),
        tokens: Math.max(0, Math.floor(r.tokens ?? 0)),
        words: Math.max(0, Math.floor(r.words ?? 0)),
        requests: 1
      })
      groups.set(key, group)
    }
    let recorded = 0
    let dropped = 0
    const users = new Map<string, Doc<'users'> | null>()
    for (const group of groups.values()) {
      if (!users.has(group.clerkId)) users.set(group.clerkId, await findUserByClerkId(ctx, group.clerkId))
      const user = users.get(group.clerkId)
      if (!user) {
        dropped += group.deltas.length
        continue
      }
      await addUsage(ctx, user._id, group.deltas, group.at)
      recorded += group.deltas.length
    }
    return { recorded, dropped }
  }
})

const grantRefusalValidator = v.union(refusalValidator, v.null())

/**
 * What the inference Worker may do for an account for the next few minutes, in one call it caches:
 * the same plan, trial and limit rules `authorize` applies, checked once for speech and for
 * formatting instead of once per request. Provisions the account like `authorize` (which also
 * starts a trial) but writes nothing else; usage arrives later through `recordBatch`.
 */
export const workerGrant = internalMutation({
  args: identityArgs,
  returns: v.union(
    v.object({
      ok: v.literal(true),
      plan: planValidator,
      planState: accessStateValidator,
      stt: grantRefusalValidator,
      llm: grantRefusalValidator,
      /** For `/v1/format`, which answers with rule-based text instead of refusing. */
      format: v.object({ refusal: grantRefusalValidator, paused: v.union(meterValidator, v.null()) })
    }),
    v.object({ ok: v.literal(false), denied: v.literal('private_testing') })
  ),
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await upsertUser(ctx, args.clerkId, { email: args.email }, now)
    const planState = accessStateOf(process.env, planStateOf(user), args, user.email)
    if (planState === 'testing') return { ok: false as const, denied: 'private_testing' as const }
    const plan = tierOf(planState)
    const limits = planLimits(plan)
    const snapshot = await snapshotFor(ctx, user._id, usageDay(now))
    const check = { plan, state: planState, limits, snapshot, now }
    const strict = checkFormatting(check, false)
    const degradable = checkFormatting(check, true)
    return {
      ok: true as const,
      plan,
      planState,
      stt: checkTranscription(check, 0),
      llm: strict.ok ? null : strict.refusal,
      format: degradable.ok
        ? { refusal: null, paused: degradable.paused }
        : { refusal: degradable.refusal, paused: null }
    }
  }
})
