import { ConvexError, v } from 'convex/values'
import { authedMutation, authedQuery } from './lib/functions'
import {
  MIC_MAX_ID_LENGTH,
  MIC_MAX_NAME_LENGTH,
  MIC_MAX_PENDING,
  MIC_MAX_SDP_LENGTH,
  MIC_REGISTRATION_REFRESH_MS,
  MIC_SIGNAL_TTL_MS,
  iceServersFromEnv
} from './lib/micProtocol'
import { findReceiver, isLive, sweep } from './lib/micStore'
import { requireMaxLength, requireNonEmpty } from './lib/normalize'
import { platformValidator } from './lib/validators'

/*
 * Phone as microphone: signaling only (docs/phone-microphone.md). A link costs one offer and one
 * answer; the audio goes peer to peer over WebRTC and never reaches Convex. Every function is
 * authed and scoped to the caller's account, so a phone can only reach its own desktops.
 */

const iceServerValidator = v.object({
  urls: v.union(v.string(), v.array(v.string())),
  username: v.optional(v.string()),
  credential: v.optional(v.string())
})

const receiverValidator = v.object({
  deviceId: v.string(),
  name: v.string(),
  platform: platformValidator,
  registeredAt: v.number()
})

const signalValidator = v.object({
  id: v.id('micSignals'),
  kind: v.union(v.literal('offer'), v.literal('answer'), v.literal('decline')),
  from: v.string(),
  fromName: v.string(),
  linkId: v.string(),
  sdp: v.string(),
  reason: v.optional(v.string()),
  createdAt: v.number()
})

function iceServers() {
  return iceServersFromEnv(process.env.MURMUR_MIC_ICE_SERVERS)
}

function requireId(value: string, field: string): string {
  return requireMaxLength(requireNonEmpty(value, field), MIC_MAX_ID_LENGTH, field)
}

function requireName(value: string, field: string): string {
  return requireMaxLength(requireNonEmpty(value, field), MIC_MAX_NAME_LENGTH, field)
}

function requireSdp(value: string): string {
  if (!value.startsWith('v=0')) throw new ConvexError('Not a session description')
  if (value.length > MIC_MAX_SDP_LENGTH) throw new ConvexError('Session description too long')
  return value
}

/**
 * The desktop turned "Phone as microphone" on (or is still on after a day, or was renamed).
 * Writes only when something changed or the row is a day old; returns the ICE servers to use.
 */
export const register = authedMutation({
  args: { deviceId: v.string(), name: v.string(), platform: platformValidator },
  returns: v.object({ iceServers: v.array(iceServerValidator) }),
  handler: async (ctx, args) => {
    const deviceId = requireId(args.deviceId, 'deviceId')
    const name = requireName(args.name, 'name')
    const now = Date.now()
    const existing = await findReceiver(ctx, ctx.user._id, deviceId)
    if (!existing) {
      await ctx.db.insert('micReceivers', {
        userId: ctx.user._id,
        deviceId,
        name,
        platform: args.platform,
        registeredAt: now
      })
    } else if (
      existing.name !== name ||
      existing.platform !== args.platform ||
      now - existing.registeredAt >= MIC_REGISTRATION_REFRESH_MS
    ) {
      await ctx.db.patch('micReceivers', existing._id, {
        name,
        platform: args.platform,
        registeredAt: now
      })
    }
    return { iceServers: iceServers() }
  }
})

/** The desktop turned the switch off (or signed out): it is no longer listed, its inbox is cleared. */
export const unregister = authedMutation({
  args: { deviceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await findReceiver(ctx, ctx.user._id, args.deviceId)
    await sweep(ctx, ctx.user._id, args.deviceId, 0, Date.now())
    if (!existing) return false
    await ctx.db.delete('micReceivers', existing._id)
    return true
  }
})

/** The desktops a phone can link to, and the ICE servers to use. A one-shot query, not a subscription. */
export const receivers = authedQuery({
  args: {},
  returns: v.object({
    receivers: v.array(receiverValidator),
    iceServers: v.array(iceServerValidator)
  }),
  handler: async (ctx) => {
    if (!ctx.user) return { receivers: [], iceServers: iceServers() }
    const now = Date.now()
    const rows = await ctx.db
      .query('micReceivers')
      .withIndex('by_user_and_deviceId', (q) => q.eq('userId', ctx.user!._id))
      .take(100)
    const live = await Promise.all(rows.map((r) => isLive(ctx, r, now)))
    return {
      receivers: rows
        .filter((_, i) => live[i])
        .map((r) => ({
          deviceId: r.deviceId,
          name: r.name,
          platform: r.platform,
          registeredAt: r.registeredAt
        }))
        .sort((a, b) => b.registeredAt - a.registeredAt),
      iceServers: iceServers()
    }
  }
})

/**
 * Signals addressed to `deviceId` that have not expired. The desktop subscribes while its switch
 * is on (an idle subscription costs nothing: it re-runs only when a row for this device is
 * written); the phone subscribes only between its offer and the answer.
 */
export const inbox = authedQuery({
  args: { deviceId: v.string() },
  returns: v.array(signalValidator),
  handler: async (ctx, args) => {
    if (!ctx.user) return []
    const now = Date.now()
    const rows = await ctx.db
      .query('micSignals')
      .withIndex('by_user_and_to', (q) => q.eq('userId', ctx.user!._id).eq('to', args.deviceId))
      .take(MIC_MAX_PENDING * 4)
    return rows
      .filter((r) => now - r.createdAt <= MIC_SIGNAL_TTL_MS)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        id: r._id,
        kind: r.kind,
        from: r.from,
        fromName: r.fromName,
        linkId: r.linkId,
        sdp: r.sdp,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        createdAt: r.createdAt
      }))
  }
})

/**
 * A phone asks a desktop for a link with its complete SDP offer. Refused (ConvexError
 * `not_listening`) when that desktop does not have the switch on.
 */
export const offer = authedMutation({
  args: {
    to: v.string(),
    from: v.string(),
    fromName: v.string(),
    linkId: v.string(),
    sdp: v.string()
  },
  returns: v.object({ id: v.id('micSignals') }),
  handler: async (ctx, args) => {
    const to = requireId(args.to, 'to')
    const from = requireId(args.from, 'from')
    const linkId = requireId(args.linkId, 'linkId')
    const fromName = requireName(args.fromName, 'fromName')
    const sdp = requireSdp(args.sdp)
    if (to === from) throw new ConvexError('A device cannot link to itself')
    const now = Date.now()
    const receiver = await findReceiver(ctx, ctx.user._id, to)
    if (!receiver || !(await isLive(ctx, receiver, now))) throw new ConvexError('not_listening')
    await sweep(ctx, ctx.user._id, to, MIC_MAX_PENDING - 1, now)
    const id = await ctx.db.insert('micSignals', {
      userId: ctx.user._id,
      to,
      from,
      fromName,
      linkId,
      kind: 'offer',
      sdp,
      createdAt: now
    })
    return { id }
  }
})

/**
 * The desktop answers an offer (or declines it with a reason). The offer is deleted and the
 * answer addressed to the phone that sent it.
 */
export const answer = authedMutation({
  args: {
    offerId: v.id('micSignals'),
    fromName: v.string(),
    sdp: v.optional(v.string()),
    reason: v.optional(v.string())
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const offerRow = await ctx.db.get('micSignals', args.offerId)
    if (!offerRow || offerRow.userId !== ctx.user._id || offerRow.kind !== 'offer') return false
    const fromName = requireName(args.fromName, 'fromName')
    const sdp = args.sdp !== undefined ? requireSdp(args.sdp) : ''
    await ctx.db.delete('micSignals', offerRow._id)
    const now = Date.now()
    if (now - offerRow.createdAt > MIC_SIGNAL_TTL_MS) return false
    await sweep(ctx, ctx.user._id, offerRow.from, MIC_MAX_PENDING - 1, now)
    await ctx.db.insert('micSignals', {
      userId: ctx.user._id,
      to: offerRow.from,
      from: offerRow.to,
      fromName,
      linkId: offerRow.linkId,
      kind: sdp ? 'answer' : 'decline',
      sdp,
      ...(sdp ? {} : { reason: (args.reason ?? 'The desktop declined the link').slice(0, 300) }),
      createdAt: now
    })
    return true
  }
})

/** The phone took its answer: delete it. */
export const take = authedMutation({
  args: { id: v.id('micSignals') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get('micSignals', args.id)
    if (!row || row.userId !== ctx.user._id) return false
    await ctx.db.delete('micSignals', row._id)
    return true
  }
})
