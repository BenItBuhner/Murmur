import { internalMutation } from '../_generated/server'
import { DAY_MS } from './lib/plans'

/** What retention removes: what people said, not the missions built from it. */
const SWEPT = ['recordings', 'segments', 'meeting_notes'] as const
const PER_RUN = 1000

/**
 * Turns expired meeting records into tombstones, so every device deletes its copy on its next pull.
 * Age is when the record first reached the cloud. Runs in bounded batches; a large backlog clears
 * over a few days.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    let budget = PER_RUN
    for await (const ws of ctx.db.query('ephemerisWorkspaces')) {
      if (!ws.retentionDays) continue
      const cutoff = now - ws.retentionDays * DAY_MS
      let seq = ws.seq
      let records = ws.records
      for (const table of SWEPT) {
        const rows = await ctx.db
          .query('ephemerisRecords')
          .withIndex('by_workspace_record', (q) => q.eq('workspaceId', ws._id).eq('table', table))
          .filter((q) => q.and(q.lt(q.field('_creationTime'), cutoff), q.neq(q.field('data'), null)))
          .take(budget)
        for (const r of rows) {
          seq++
          records--
          await ctx.db.patch('ephemerisRecords', r._id, { data: null, version: Math.max(r.version + 1, now), deviceId: 'retention', seq })
        }
        budget -= rows.length
        if (budget <= 0) break
      }
      if (seq !== ws.seq) await ctx.db.patch('ephemerisWorkspaces', ws._id, { seq, records })
      if (budget <= 0) break
    }
  }
})
