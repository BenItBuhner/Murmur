import { internal } from './_generated/api'
import { httpAction, type ActionCtx } from './_generated/server'
import {
  handleChatCompletions,
  handleFormat,
  handleModels,
  handleTranscriptions,
  type Gate,
  type GatewayHooks
} from './lib/gatewayCore'
import { gatewayError, identityOf, type GatewayIdentity } from './lib/inference'
import type { Id } from './_generated/dataModel'

/**
 * The managed inference gateway as Convex HTTP actions. Every request here buffers the audio in an
 * action and runs authorize + record (+ breaker) mutations, which is what pushed Murmur past the
 * Convex free plan; the same handlers (lib/gatewayCore.ts) now run in the inference Worker
 * (apps/inference-worker) and clients use that when it is configured. These routes stay as the
 * fallback for clients that do not know the Worker yet, and can be switched off without a client
 * release by setting MURMUR_CONVEX_GATEWAY=off in the deployment's environment.
 */

function callerArgs(identity: GatewayIdentity): { clerkId: string; email?: string; emailVerified?: boolean } {
  return { clerkId: identity.subject, email: identity.email, emailVerified: identity.emailVerified }
}

/** `MURMUR_CONVEX_GATEWAY=off` turns the Convex routes off (they answer 410 with where to go). */
export function convexGatewayEnabled(env: Record<string, string | undefined>): boolean {
  return (env.MURMUR_CONVEX_GATEWAY ?? '').trim().toLowerCase() !== 'off'
}

function gatewayOff(): Response {
  return gatewayError(
    503,
    'not_configured',
    'Murmur models moved; update Murmur to keep using them'
  )
}

function convexHooks(ctx: ActionCtx): GatewayHooks {
  return {
    env: process.env,
    access: (identity) => ctx.runQuery(internal.inference.access, callerArgs(identity)),
    authorize: async ({ identity, ...rest }) =>
      (await ctx.runMutation(internal.inference.authorize, { ...callerArgs(identity), ...rest })) as Gate,
    record: async ({ userId, identity: _identity, ...rest }) => {
      await ctx.runMutation(internal.inference.record, { userId: userId as Id<'users'>, ...rest })
    },
    providerFailed: (kind, reason) => ctx.runMutation(internal.inference.providerFailed, { kind, reason }),
    providerRecovered: async (kind) => {
      await ctx.runMutation(internal.inference.providerRecovered, { kind })
    }
  }
}

export const models = httpAction(async (ctx) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleModels(convexHooks(ctx), await identityOf(ctx.auth))
})

export const transcriptions = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleTranscriptions(convexHooks(ctx), await identityOf(ctx.auth), request)
})

export const chatCompletions = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleChatCompletions(convexHooks(ctx), await identityOf(ctx.auth), request)
})

export const format = httpAction(async (ctx, request) => {
  if (!convexGatewayEnabled(process.env)) return gatewayOff()
  return handleFormat(convexHooks(ctx), await identityOf(ctx.auth), request)
})
