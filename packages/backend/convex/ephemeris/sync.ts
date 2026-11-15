import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { mutation, query } from '../_generated/server'
import { fail, requireMember } from './lib/auth'
import { MAX_BATCH, MAX_PULL, MAX_RECORD_BYTES, SYNCED_TABLES, validRecordId, wins } from './lib/merge'
import { entitlements } from './lib/plans'

const changeV = v.object({
  table: v.string(),
  recordId: v.string(),
  /** The row as JSON, or null for a delete. */
  data: v.union(v.string(), v.null()),
  version: v.number()
})

const tables: ReadonlySet<string> = new Set(SYNCED_TABLES)

function out(r: Doc<'ephemerisRecords'>) {
  return { table: r.table, recordId: r.recordId, data: r.data, version: r.version, deviceId: r.deviceId, seq: r.seq }
}

/**
 * Sends a device's changes. Each one lands unless the workspace already holds a later copy of that
 * record; the later copy comes back in `stale` so the device can take it. New records past the
 * plan's limit come back in `refused` and stay on the device.
 */
export const push = mutation({
  args: { workspaceId: v.id('ephemerisWorkspaces'), deviceId: v.string(), changes: v.array(changeV) },
  handler: async (ctx, { workspaceId, deviceId, changes }) => {
    const { user, workspace } = await requireMember(ctx, workspaceId)
    if (changes.length > MAX_BATCH) fail('invalid', `Send at most ${MAX_BATCH} changes at once.`)
    if (!deviceId || deviceId.length > 100) fail('invalid', 'Missing device id.')
    const now = Date.now()
    const limit = entitlements(workspace, now).syncRecords
    let seq = workspace.seq
    let records = workspace.records
    const stale: ReturnType<typeof out>[] = []
    const refused: Array<{ table: string; recordId: string; reason: string }> = []
    let accepted = 0

    for (const c of changes) {
      if (!tables.has(c.table) || !validRecordId(c.recordId)) {
        refused.push({ table: c.table, recordId: c.recordId, reason: 'unknown' })
        continue
      }
      if (c.data !== null && c.data.length > MAX_RECORD_BYTES) {
        refused.push({ table: c.table, recordId: c.recordId, reason: 'too_large' })
        continue
      }
      const current = await ctx.db
        .query('ephemerisRecords')
        .withIndex('by_workspace_record', (q) => q.eq('workspaceId', workspaceId).eq('table', c.table).eq('recordId', c.recordId))
        .unique()
      const resend = !!current && current.version === c.version && current.deviceId === deviceId
      if (resend && current.data === c.data) {
        accepted++ // the same change sent twice
        continue
      }
      if (!resend && !wins({ version: c.version, deviceId }, current)) {
        stale.push(out(current!))
        continue
      }
      const wasLive = !!current && current.data !== null
      const isLive = c.data !== null
      if (isLive && !wasLive && limit !== null && records >= limit) {
        refused.push({ table: c.table, recordId: c.recordId, reason: 'limit' })
        continue
      }
      seq++
      records += (isLive ? 1 : 0) - (wasLive ? 1 : 0)
      const row = { data: c.data, version: c.version, deviceId, authorId: user._id, seq }
      if (current) await ctx.db.patch('ephemerisRecords', current._id, row)
      else await ctx.db.insert('ephemerisRecords', { workspaceId, table: c.table, recordId: c.recordId, ...row })
      accepted++
    }
    if (seq !== workspace.seq || records !== workspace.records) await ctx.db.patch('ephemerisWorkspaces', workspaceId, { seq, records })
    return { accepted, stale, refused, seq }
  }
})

/** Everything that changed in a workspace after `after`, oldest first. Call again while `more`. */
export const pull = query({
  args: { workspaceId: v.id('ephemerisWorkspaces'), after: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { workspaceId, after, limit }) => {
    const { workspace } = await requireMember(ctx, workspaceId)
    const n = Math.min(MAX_PULL, Math.max(1, limit ?? MAX_PULL))
    const rows = await ctx.db
      .query('ephemerisRecords')
      .withIndex('by_workspace_seq', (q) => q.eq('workspaceId', workspaceId).gt('seq', after))
      .take(n + 1)
    const page = rows.slice(0, n)
    return {
      changes: page.map(out),
      cursor: page.length ? page[page.length - 1]!.seq : after,
      more: rows.length > n,
      head: workspace.seq
    }
  }
})

/** Where a workspace's sync stands: how much it holds against the plan's limit. */
export const status = query({
  args: { workspaceId: v.id('ephemerisWorkspaces') },
  handler: async (ctx, { workspaceId }) => {
    const { workspace } = await requireMember(ctx, workspaceId)
    const e = entitlements(workspace, Date.now())
    return { head: workspace.seq, records: workspace.records, limit: e.syncRecords, plan: e.plan }
  }
})
