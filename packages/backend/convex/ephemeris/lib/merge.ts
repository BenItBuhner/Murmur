/**
 * How two copies of one record settle: the later change wins, by the writer's clock; on a tie the
 * larger device id wins, so every replica picks the same copy whatever order changes arrive in.
 * Deletes are ordinary changes with no data (tombstones), so a delete and an edit settle the same way.
 */
export interface Stamp {
  version: number
  deviceId: string
}

export function wins(incoming: Stamp, current: Stamp | null): boolean {
  if (!current) return true
  if (incoming.version !== current.version) return incoming.version > current.version
  return incoming.deviceId > current.deviceId
}

/** Tables a device may sync, and nothing else: keeps a client bug from filling a workspace with junk. */
export const SYNCED_TABLES = [
  'missions',
  'phases',
  'steps',
  'items',
  'recordings',
  'segments',
  'signals',
  'links',
  'meeting_notes',
  'prefs',
  /** What a phone saw: screen text, notifications, the app in front (Murmur/Ephemeris Android). */
  'context'
] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]

export const MAX_BATCH = 200
/** Convex documents top out at 1 MiB; a record's JSON stays well under it. */
export const MAX_RECORD_BYTES = 800_000
export const MAX_PULL = 500

export function validRecordId(id: string): boolean {
  return id.length > 0 && id.length <= 200
}
