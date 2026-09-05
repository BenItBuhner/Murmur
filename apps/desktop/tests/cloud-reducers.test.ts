import { describe, expect, it } from 'vitest'
import { defaultSettings, type DictionaryEntry } from '@shared/settings'
import type { HistoryEntry } from '@shared/types'
import {
  ackUpsert,
  appRulesSpec,
  applyRemotePreferences,
  deriveCollection,
  deriveStats,
  dictionarySpec,
  diffCollection,
  extractPreferences,
  historyFromRemote,
  historyToPush,
  localDay,
  mergePreferencePatches,
  preferencesPatch,
  pruneAcked,
  queueHistoryPush,
  queueRemove,
  queueUpsert,
  sameDictionaryEntry,
  type HistoryPushEntry,
  type OutboxOp,
  type RemoteDictionaryEntry
} from '../src/main/cloud/reducers'

const remote = (id: string, word: string, createdAt = 1): RemoteDictionaryEntry => ({
  id,
  word,
  aliases: [],
  fuzzy: false,
  createdAt,
  updatedAt: createdAt
})

const local = (id: string, word: string, createdAt = 1): DictionaryEntry => ({
  id,
  word,
  aliases: [],
  fuzzy: false,
  createdAt
})

const upsert = (
  opId: string,
  entry: DictionaryEntry,
  remoteId?: string,
  acked = false
): OutboxOp => ({
  id: opId,
  kind: 'dictionary.upsert',
  localId: entry.id,
  remoteId,
  acked,
  entry: {
    word: entry.word,
    aliases: entry.aliases,
    fuzzy: entry.fuzzy,
    createdAt: entry.createdAt
  }
})

describe('deriveCollection', () => {
  it('keeps the local mirror untouched until the first server snapshot', () => {
    const mirror = [local('a', 'Alpha')]
    expect(deriveCollection(dictionarySpec, null, mirror, [])).toEqual(mirror)
  })

  it('replaces the mirror with the server snapshot, newest first', () => {
    const server = [remote('r1', 'Old', 1), remote('r2', 'New', 5)]
    const out = deriveCollection(dictionarySpec, server, [local('stale', 'Stale')], [])
    expect(out.map((e) => e.word)).toEqual(['New', 'Old'])
    expect(out[0].id).toBe('r2')
  })

  it('layers unsent local additions and removals on top of the snapshot', () => {
    const server = [remote('r1', 'Kept', 1), remote('r2', 'Gone', 2)]
    const ops: OutboxOp[] = [
      upsert('op1', local('tmp1', 'Added', 9)),
      { id: 'op2', kind: 'dictionary.remove', remoteId: 'r2' }
    ]
    const out = deriveCollection(dictionarySpec, server, [], ops)
    expect(out.map((e) => e.word)).toEqual(['Added', 'Kept'])
    expect(out[0].id).toBe('tmp1')
  })

  it('shows an acknowledged upsert under its server id until the snapshot echoes it', () => {
    const acked = upsert('op1', local('tmp1', 'Fresh', 3), 'r9', true)
    const before = deriveCollection(dictionarySpec, [remote('r1', 'Old')], [], [acked])
    expect(before.map((e) => e.id)).toEqual(['r9', 'r1'])
    const after = deriveCollection(
      dictionarySpec,
      [remote('r9', 'Fresh', 3), remote('r1', 'Old')],
      [],
      [acked]
    )
    expect(after.map((e) => e.id)).toEqual(['r9', 'r1'])
    expect(after).toHaveLength(2)
  })

  it('an edit to a server-known item updates it in place', () => {
    const server = [remote('r1', 'Convex', 1)]
    const ops = [upsert('op1', { ...local('r1', 'Convex', 1), fuzzy: true }, 'r1')]
    const out = deriveCollection(dictionarySpec, server, [], ops)
    expect(out).toEqual([{ id: 'r1', word: 'Convex', aliases: [], fuzzy: true, createdAt: 1 }])
  })

  it('preserves server order for app rules and appends local additions', () => {
    const server = [
      { id: 'r1', match: 'mail', tone: 'professional' as const, createdAt: 2, updatedAt: 2 },
      {
        id: 'r2',
        match: 'slack',
        tone: 'casual' as const,
        formatting: 'light' as const,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const ops: OutboxOp[] = [
      {
        id: 'op1',
        kind: 'appRules.upsert',
        localId: 'tmp',
        rule: { match: 'terminal', tone: 'neutral', trailingSpace: false, createdAt: 3 }
      }
    ]
    const out = deriveCollection(appRulesSpec, server, [], ops)
    expect(out).toEqual([
      { id: 'r1', match: 'mail', tone: 'professional' },
      { id: 'r2', match: 'slack', tone: 'casual', formatting: 'light' },
      { id: 'tmp', match: 'terminal', tone: 'neutral', trailingSpace: false }
    ])
  })
})

describe('outbox queue rules', () => {
  it('an unsent upsert for the same item is replaced, an acknowledged one is kept', () => {
    const a = upsert('op1', local('x', 'One'))
    const b = upsert('op2', local('x', 'Two'))
    expect(queueUpsert([a], b).map((op) => op.id)).toEqual(['op2'])
    const acked = upsert('op1', local('x', 'One'), 'r1', true)
    expect(queueUpsert([acked], b).map((op) => op.id)).toEqual(['op1', 'op2'])
  })

  it('removing a never-sent item just drops its upsert; removing a server item queues a delete', () => {
    const pending = upsert('op1', local('tmp', 'Draft'))
    expect(
      queueRemove([pending], 'dictionary.upsert', 'dictionary.remove', 'tmp', undefined, 'op2')
    ).toEqual([])
    const out = queueRemove([], 'dictionary.upsert', 'dictionary.remove', 'r1', 'r1', 'op3')
    expect(out).toEqual([{ id: 'op3', kind: 'dictionary.remove', remoteId: 'r1' }])
    // An acknowledged upsert whose server id we know is deleted by that id.
    const acked = upsert('op1', local('tmp', 'Draft'), 'r7', true)
    const viaAck = queueRemove(
      [acked],
      'dictionary.upsert',
      'dictionary.remove',
      'tmp',
      undefined,
      'op4'
    )
    expect(viaAck).toEqual([{ id: 'op4', kind: 'dictionary.remove', remoteId: 'r7' }])
  })

  it('ack + prune lifecycle', () => {
    const ops = [upsert('op1', local('tmp', 'Word'))]
    const acked = ackUpsert(ops, 'op1', 'r1')
    expect(acked[0]).toMatchObject({ acked: true, remoteId: 'r1' })
    expect(pruneAcked(acked, new Set(['other']))).toHaveLength(1)
    expect(pruneAcked(acked, new Set(['r1']))).toHaveLength(0)
  })

  it('batches history pushes', () => {
    const entry = (id: string): HistoryPushEntry => ({
      entryId: id,
      createdAt: 1,
      mode: 'hold' as const,
      finalText: 'x',
      wordCount: 1,
      speechMs: 1,
      provider: 'p',
      model: 'm',
      llmUsed: false
    })
    let ops: OutboxOp[] = []
    ops = queueHistoryPush(ops, entry('a'), 'op1', 2)
    ops = queueHistoryPush(ops, entry('b'), 'op2', 2)
    ops = queueHistoryPush(ops, entry('c'), 'op3', 2)
    expect(ops.map((op) => (op.kind === 'history.push' ? op.entries.length : 0))).toEqual([2, 1])
  })
})

describe('diffCollection', () => {
  it('reports additions, changes and removals by id', () => {
    const prev = [local('a', 'A'), local('b', 'B'), local('c', 'C')]
    const next = [local('a', 'A'), { ...local('b', 'B'), fuzzy: true }, local('d', 'D')]
    const diff = diffCollection(prev, next, sameDictionaryEntry)
    expect(diff.added.map((e) => e.id)).toEqual(['d'])
    expect(diff.changed.map((e) => e.id)).toEqual(['b'])
    expect(diff.removed.map((e) => e.id)).toEqual(['c'])
  })
})

describe('preferences', () => {
  it('extracts only cross-device style settings and patches just what changed', () => {
    const s = defaultSettings()
    const prefs = extractPreferences(s)
    expect(Object.keys(prefs)).toEqual(['formatting', 'language', 'sync'])
    expect(prefs.formatting.mode).toBe('smart')
    expect(prefs.language).toBe('auto')

    const next = { ...prefs, language: 'en' }
    expect(preferencesPatch(prefs, next)).toEqual({ language: 'en' })
    const toggled = { ...prefs, sync: { history: true } }
    expect(preferencesPatch(prefs, toggled)).toEqual({ sync: { history: true } })
    const styled = { ...prefs, formatting: { ...prefs.formatting, tone: 'casual' as const } }
    expect(preferencesPatch(prefs, styled).formatting?.tone).toBe('casual')
  })

  it('merges pending patches and applies remote values over local defaults', () => {
    const merged = mergePreferencePatches(
      { formatting: { mode: 'light' }, language: 'de' },
      { formatting: { tone: 'casual' }, sync: { history: true } }
    )
    expect(merged).toEqual({
      formatting: { mode: 'light', tone: 'casual' },
      language: 'de',
      sync: { history: true }
    })

    const s = defaultSettings()
    const applied = applyRemotePreferences(
      s,
      { formatting: { tone: 'professional' }, language: 'fr' },
      { sync: { history: true } }
    )
    expect(applied.formatting).toEqual({ tone: 'professional' })
    expect(applied.stt.language).toBe('fr')
    expect(applied.cloud.historySync).toBe(true)

    const untouched = applyRemotePreferences(s, null, null)
    expect(untouched.formatting).toEqual({})
    expect(untouched.stt.language).toBe('auto')
    expect(untouched.cloud.historySync).toBe(false)
  })
})

describe('stats', () => {
  it('uses server totals plus pending sessions', () => {
    const local = {
      totalWords: 500,
      totalSessions: 50,
      totalSpeechMs: 9,
      streakDays: 4,
      lastSessionDay: '2026-09-05'
    }
    expect(deriveStats(local, null, [])).toEqual(local)
    const server = {
      totalWords: 10,
      totalSessions: 1,
      totalSpeechMs: 100,
      streakDays: 1,
      lastSessionDay: '2026-09-04'
    }
    const ops: OutboxOp[] = [
      { id: 'o1', kind: 'stats.record', sessionId: 's1', words: 5, speechMs: 50, day: '2026-09-05' }
    ]
    expect(deriveStats(local, server, ops)).toEqual({
      totalWords: 15,
      totalSessions: 2,
      totalSpeechMs: 150,
      streakDays: 4,
      lastSessionDay: '2026-09-05'
    })
    expect(deriveStats(local, server, [])).toEqual({ ...server })
  })

  it('formats the local calendar day', () => {
    expect(localDay(new Date(2026, 8, 5, 23, 30))).toBe('2026-09-05')
    expect(localDay(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('history mapping', () => {
  const entry: HistoryEntry = {
    id: 'h1',
    createdAt: 123,
    mode: 'hold',
    rawText: 'um hello',
    finalText: 'Hello.',
    wordCount: 1,
    speechMs: 800,
    appName: 'Slack',
    provider: 'openai-compatible',
    model: 'whisper-1',
    injected: true,
    llmUsed: true,
    timings: { recordMs: 800, vadMs: 1, sttMs: 2, formatMs: 3, llmMs: 4, injectMs: 5, totalMs: 15 }
  }

  it('pushes only successful dictations and round-trips remote entries', () => {
    expect(historyToPush(entry)).toEqual({
      entryId: 'h1',
      createdAt: 123,
      mode: 'hold',
      rawText: 'um hello',
      finalText: 'Hello.',
      wordCount: 1,
      speechMs: 800,
      appName: 'Slack',
      provider: 'openai-compatible',
      model: 'whisper-1',
      llmUsed: true
    })
    expect(historyToPush({ ...entry, error: 'failed', finalText: '' })).toBeNull()
    const back = historyFromRemote({
      ...historyToPush(entry)!,
      deviceId: 'phone',
      deviceName: 'Pixel'
    })
    expect(back).toMatchObject({
      id: 'h1',
      finalText: 'Hello.',
      remote: true,
      deviceId: 'phone',
      deviceName: 'Pixel'
    })
  })
})
