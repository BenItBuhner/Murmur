import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery } from './lib/functions'
import { LIMITS } from './lib/limits'
import { requireMaxLength, requireNonEmpty } from './lib/normalize'
import { deviceDtoValidator, platformValidator, type DeviceDto } from './lib/validators'

/** A heartbeat writes liveness at most this often per device; more frequent calls are read-only. */
const LIVENESS_WRITE_MS = 10 * 60_000

export function toDto(doc: Doc<'devices'>): DeviceDto {
  return {
    id: doc._id,
    deviceId: doc.deviceId,
    name: doc.name,
    platform: doc.platform,
    appVersion: doc.appVersion,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt
  }
}

/**
 * Devices that have connected to this account, most recently seen first. The last-seen time is
 * joined from `deviceLiveness` (where heartbeats write, at most once every ten minutes), so this
 * stays as fresh as the throttle allows without the per-heartbeat row patch that used to re-run
 * every subscriber after every heartbeat. `bootstrap.get` answers the same join for new clients.
 */
export const list = authedQuery({
  args: {},
  returns: v.array(deviceDtoValidator),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const [docs, liveness] = await Promise.all([
      ctx.db
        .query('devices')
        .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
        .collect(),
      ctx.db
        .query('deviceLiveness')
        .withIndex('by_user_and_deviceId', (q) => q.eq('userId', ctx.user!._id))
        .collect()
    ])
    const seen = new Map(liveness.map((l) => [l.deviceId, l.lastSeenAt]))
    return docs
      .map((d) => ({ ...toDto(d), lastSeenAt: seen.get(d.deviceId) ?? d.lastSeenAt }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }
})

/**
 * Register this install (or refresh its last-seen time). Called on connect and periodically.
 *
 * The devices row is read by `devices.list` and `bootstrap.get`, so it is patched only when the
 * registration actually changed (name, platform, appVersion) — never routinely. The last-seen
 * time lives in `deviceLiveness` (see the schema), written at most once per
 * [LIVENESS_WRITE_MS]: a more frequent heartbeat answers without writing at all. `devices.list`
 * and `bootstrap.get` join the liveness row, so clients see a last-seen time that is at most ten
 * minutes stale, and a liveness write re-runs their subscribers only at that same pace.
 */
export const heartbeat = authedMutation({
  args: {
    deviceId: v.string(),
    name: v.string(),
    platform: platformValidator,
    appVersion: v.string()
  },
  returns: deviceDtoValidator,
  handler: async (ctx, args) => {
    const deviceId = requireNonEmpty(args.deviceId, 'deviceId')
    const name = requireMaxLength(requireNonEmpty(args.name, 'name'), LIMITS.deviceNameLength, 'name')
    const now = Date.now()
    const existing = await ctx.db
      .query('devices')
      .withIndex('by_user_and_deviceId', (q) => q.eq('userId', ctx.user._id).eq('deviceId', deviceId))
      .unique()

    if (existing) {
      const liveness = await ctx.db
        .query('deviceLiveness')
        .withIndex('by_user_and_deviceId', (q) => q.eq('userId', ctx.user._id).eq('deviceId', deviceId))
        .unique()
      const seen = Math.max(existing.lastSeenAt, liveness?.lastSeenAt ?? 0)
      const changed =
        existing.name !== name || existing.platform !== args.platform || existing.appVersion !== args.appVersion
      // A real registration change applies at once (a rename is what devices.list exists to show);
      // the routine heartbeat, which changes nothing, writes nothing at all.
      if (changed)
        await ctx.db.patch('devices', existing._id, {
          name,
          platform: args.platform,
          appVersion: args.appVersion
        })
      if (now - seen >= LIVENESS_WRITE_MS) {
        if (liveness) await ctx.db.patch('deviceLiveness', liveness._id, { lastSeenAt: now })
        else await ctx.db.insert('deviceLiveness', { userId: ctx.user._id, deviceId, lastSeenAt: now })
        return toDto({
          ...existing,
          ...(changed ? { name, platform: args.platform, appVersion: args.appVersion } : {}),
          lastSeenAt: now
        })
      }
      return toDto({
        ...existing,
        ...(changed ? { name, platform: args.platform, appVersion: args.appVersion } : {}),
        lastSeenAt: seen
      })
    }
    const all = await ctx.db
      .query('devices')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
      .collect()
    if (all.length >= LIMITS.devices) {
      // Evict the device that has been silent the longest rather than refusing the new one.
      const stale = all.sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (stale) {
        await ctx.db.delete('devices', stale._id)
        const staleLiveness = await ctx.db
          .query('deviceLiveness')
          .withIndex('by_user_and_deviceId', (q) =>
            q.eq('userId', ctx.user._id).eq('deviceId', stale.deviceId)
          )
          .unique()
        if (staleLiveness) await ctx.db.delete('deviceLiveness', staleLiveness._id)
      }
    }
    const id = await ctx.db.insert('devices', {
      userId: ctx.user._id,
      deviceId,
      name,
      platform: args.platform,
      appVersion: args.appVersion,
      lastSeenAt: now,
      createdAt: now
    })
    await ctx.db.insert('deviceLiveness', { userId: ctx.user._id, deviceId, lastSeenAt: now })
    const inserted = await ctx.db.get('devices', id)
    if (!inserted) throw new Error('Failed to register device')
    return toDto(inserted)
  }
})

/** Forget a device. Returns false when it was not registered to this account. */
export const remove = authedMutation({
  args: { deviceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('devices')
      .withIndex('by_user_and_deviceId', (q) =>
        q.eq('userId', ctx.user._id).eq('deviceId', args.deviceId)
      )
      .unique()
    if (!existing) return false
    await ctx.db.delete('devices', existing._id)
    const liveness = await ctx.db
      .query('deviceLiveness')
      .withIndex('by_user_and_deviceId', (q) =>
        q.eq('userId', ctx.user._id).eq('deviceId', args.deviceId)
      )
      .unique()
    if (liveness) await ctx.db.delete('deviceLiveness', liveness._id)
    return true
  }
})
