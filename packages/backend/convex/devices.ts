import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery } from './lib/functions'
import { LIMITS } from './lib/limits'
import { requireMaxLength, requireNonEmpty } from './lib/normalize'
import { deviceDtoValidator, platformValidator, type DeviceDto } from './lib/validators'

function toDto(doc: Doc<'devices'>): DeviceDto {
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

/** Devices that have connected to this account, most recently seen first. */
export const list = authedQuery({
  args: {},
  returns: v.array(deviceDtoValidator),
  handler: async (ctx) => {
    if (!ctx.user) return []
    const docs = await ctx.db
      .query('devices')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user!._id))
      .collect()
    return docs.sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(toDto)
  }
})

/** Register this install (or refresh its last-seen time). Called on connect and periodically. */
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
      const patch = { name, platform: args.platform, appVersion: args.appVersion, lastSeenAt: now }
      await ctx.db.patch('devices', existing._id, patch)
      return toDto({ ...existing, ...patch })
    }
    const all = await ctx.db
      .query('devices')
      .withIndex('by_user', (q) => q.eq('userId', ctx.user._id))
      .collect()
    if (all.length >= LIMITS.devices) {
      // Evict the device that has been silent the longest rather than refusing the new one.
      const stale = all.sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (stale) await ctx.db.delete('devices', stale._id)
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
    return true
  }
})
