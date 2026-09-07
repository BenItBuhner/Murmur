import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { authedQuery } from './lib/functions'
import { MURMUR_MODELS, readUpstreams } from './lib/inference'
import {
  DEFAULT_PLAN,
  MAX_CLIP_SECONDS,
  RATE_WINDOW_MS,
  planLimits,
  planValidator,
  usagePeriod,
  type Plan
} from './lib/plans'
import { upsertUser } from './lib/users'
import {
  inferenceKindValidator,
  inferenceStatusValidator,
  type InferenceStatus
} from './lib/validators'

/**
 * Account-side view of the managed inference gateway (convex/gateway.ts): which models this
 * instance offers, what the account's tier allows, and how much of it has been used.
 */

const ZERO_USAGE = { sttSeconds: 0, sttRequests: 0, llmTokens: 0, llmRequests: 0 }

async function usageFor(
  ctx: MutationCtx,
  userId: Id<'users'>,
  period: string
): Promise<Doc<'inferenceUsage'> | null> {
  return await ctx.db
    .query('inferenceUsage')
    .withIndex('by_user_and_period', (q) => q.eq('userId', userId).eq('period', period))
    .unique()
}

/** The instance's managed models and this account's allowance and usage. */
export const status = authedQuery({
  args: {},
  returns: inferenceStatusValidator,
  handler: async (ctx): Promise<InferenceStatus> => {
    const upstreams = readUpstreams(process.env)
    const plan: Plan = ctx.user?.plan ?? DEFAULT_PLAN
    const limits = planLimits(plan)
    // Newest month with any usage; `period` sorts lexicographically, so the index order is enough.
    const latest = ctx.user
      ? await ctx.db
          .query('inferenceUsage')
          .withIndex('by_user_and_period', (q) => q.eq('userId', ctx.user!._id))
          .order('desc')
          .first()
      : null
    return {
      available: upstreams.stt !== null,
      models: {
        stt: upstreams.stt ? MURMUR_MODELS.stt : null,
        llm: upstreams.llm ? MURMUR_MODELS.llm : null
      },
      plan,
      limits: { ...limits, maxClipSeconds: MAX_CLIP_SECONDS },
      usage: latest
        ? {
            period: latest.period,
            sttSeconds: latest.sttSeconds,
            sttRequests: latest.sttRequests,
            llmTokens: latest.llmTokens,
            llmRequests: latest.llmRequests
          }
        : { period: '', ...ZERO_USAGE }
    }
  }
})

const authorizeResultValidator = v.union(
  v.object({ ok: v.literal(true), userId: v.id('users'), plan: planValidator }),
  v.object({
    ok: v.literal(false),
    status: v.number(),
    code: v.union(v.literal('quota_exceeded'), v.literal('rate_limited'), v.literal('clip_too_long')),
    message: v.string(),
    retryAfterSec: v.optional(v.number())
  })
)

/**
 * Gate one managed request. Provisions the account row if the Clerk webhook has not created it yet,
 * refuses when the month's allowance is spent or the account is asking too fast, and otherwise
 * counts the request against the rate window. Usage itself is added by `record` once the upstream
 * answered, so a failed request never costs allowance.
 */
export const authorize = internalMutation({
  args: {
    clerkId: v.string(),
    kind: inferenceKindValidator,
    /** Clip length for speech requests, so a request that cannot fit is refused up front. */
    seconds: v.optional(v.number())
  },
  returns: authorizeResultValidator,
  handler: async (ctx, args) => {
    const now = Date.now()
    const user = await upsertUser(ctx, args.clerkId, {}, now)
    const plan: Plan = user.plan ?? DEFAULT_PLAN
    const limits = planLimits(plan)
    const period = usagePeriod(now)
    const usage = await usageFor(ctx, user._id, period)
    const seconds = Math.max(0, args.seconds ?? 0)

    if (args.kind === 'stt') {
      if (seconds > MAX_CLIP_SECONDS) {
        return {
          ok: false as const,
          status: 413,
          code: 'clip_too_long' as const,
          message: `Clips longer than ${Math.round(MAX_CLIP_SECONDS / 60)} minutes cannot be sent to Murmur's speech model`
        }
      }
      const used = usage?.sttSeconds ?? 0
      if (used >= limits.sttSecondsPerMonth || used + seconds > limits.sttSecondsPerMonth) {
        return {
          ok: false as const,
          status: 429,
          code: 'quota_exceeded' as const,
          message: `This month's ${Math.round(limits.sttSecondsPerMonth / 60)} minutes of Murmur transcription on the ${plan} plan are used up`
        }
      }
    } else if ((usage?.llmTokens ?? 0) >= limits.llmTokensPerMonth) {
      return {
        ok: false as const,
        status: 429,
        code: 'quota_exceeded' as const,
        message: `This month's Murmur formatting allowance on the ${plan} plan is used up`
      }
    }

    const windowFresh = usage?.windowStart !== undefined && now - usage.windowStart < RATE_WINDOW_MS
    const windowStart = windowFresh ? usage!.windowStart! : now
    const windowCount = windowFresh ? (usage!.windowCount ?? 0) : 0
    if (windowCount >= limits.requestsPerMinute) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1000))
      return {
        ok: false as const,
        status: 429,
        code: 'rate_limited' as const,
        message: `Too many requests; try again in ${retryAfterSec}s`,
        retryAfterSec
      }
    }
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
        ...ZERO_USAGE,
        windowStart,
        windowCount: 1,
        updatedAt: now
      })
    }
    return { ok: true as const, userId: user._id, plan }
  }
})

/** Add what a successful upstream request consumed to the current month. */
export const record = internalMutation({
  args: {
    userId: v.id('users'),
    kind: inferenceKindValidator,
    seconds: v.optional(v.number()),
    tokens: v.optional(v.number())
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now()
    const period = usagePeriod(now)
    const usage = await usageFor(ctx, args.userId, period)
    const seconds = Math.max(0, args.seconds ?? 0)
    const tokens = Math.max(0, Math.floor(args.tokens ?? 0))
    const delta =
      args.kind === 'stt'
        ? { sttSeconds: (usage?.sttSeconds ?? 0) + seconds, sttRequests: (usage?.sttRequests ?? 0) + 1 }
        : { llmTokens: (usage?.llmTokens ?? 0) + tokens, llmRequests: (usage?.llmRequests ?? 0) + 1 }
    if (usage) {
      await ctx.db.patch('inferenceUsage', usage._id, { ...delta, updatedAt: now })
    } else {
      await ctx.db.insert('inferenceUsage', {
        userId: args.userId,
        period,
        ...ZERO_USAGE,
        ...delta,
        updatedAt: now
      })
    }
    return null
  }
})
