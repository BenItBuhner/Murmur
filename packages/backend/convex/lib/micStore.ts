import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { MIC_MAX_PENDING, MIC_RECEIVER_STALE_MS, MIC_SIGNAL_TTL_MS } from './micProtocol'

/* Phone as microphone (docs/phone-microphone.md): the rows micLink.ts reads and writes. */

export async function findReceiver(ctx: MutationCtx, userId: Id<'users'>, deviceId: string) {
  return await ctx.db
    .query('micReceivers')
    .withIndex('by_user_and_deviceId', (q) => q.eq('userId', userId).eq('deviceId', deviceId))
    .unique()
}

/**
 * Whether the receiver's desktop is still running and signed in: seen by its heartbeat lately,
 * or registered lately (the first heartbeat may still be on its way).
 */
export async function isLive(ctx: QueryCtx, receiver: Doc<'micReceivers'>, now: number) {
  if (now - receiver.registeredAt <= MIC_RECEIVER_STALE_MS) return true
  const liveness = await ctx.db
    .query('deviceLiveness')
    .withIndex('by_user_and_deviceId', (q) =>
      q.eq('userId', receiver.userId).eq('deviceId', receiver.deviceId)
    )
    .unique()
  return liveness !== null && now - liveness.lastSeenAt <= MIC_RECEIVER_STALE_MS
}

/** Deletes everything "Phone as microphone" keeps for one device (removal, account deletion). */
export async function purgeMicDevice(ctx: MutationCtx, userId: Id<'users'>, deviceId: string) {
  const receiver = await findReceiver(ctx, userId, deviceId)
  if (receiver) await ctx.db.delete('micReceivers', receiver._id)
  await sweep(ctx, userId, deviceId, 0, Date.now())
}

/**
 * Drops the addressee's expired signals and, beyond `keep` pending ones, the oldest. This is the
 * only sweep there is: it runs on each write to the same addressee, so rows never outlive the
 * next link and no cron is needed.
 */
export async function sweep(
  ctx: MutationCtx,
  userId: Id<'users'>,
  to: string,
  keep: number,
  now: number
) {
  const rows = await ctx.db
    .query('micSignals')
    .withIndex('by_user_and_to', (q) => q.eq('userId', userId).eq('to', to))
    .take(MIC_MAX_PENDING * 4)
  const live: Doc<'micSignals'>[] = []
  for (const row of rows) {
    if (now - row.createdAt > MIC_SIGNAL_TTL_MS) await ctx.db.delete('micSignals', row._id)
    else live.push(row)
  }
  live.sort((a, b) => a.createdAt - b.createdAt)
  while (live.length > keep) {
    const oldest = live.shift()!
    await ctx.db.delete('micSignals', oldest._id)
  }
}
