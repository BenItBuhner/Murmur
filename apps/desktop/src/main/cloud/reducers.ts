import type { AppRule, DictionaryEntry, Settings, Snippet } from '@shared/settings'
import type { HistoryEntry } from '@shared/types'

/**
 * Pure functions behind the sync engine. The engine keeps two inputs per synced collection - the
 * last snapshot received from Convex and the queue of local operations not yet confirmed - and
 * derives the mirror the rest of the app reads from them. Nothing here touches Electron or the
 * network, so every rule is unit-testable.
 */

export interface DictionaryInput {
  word: string
  aliases: string[]
  fuzzy: boolean
  createdAt: number
}

export interface SnippetInput {
  trigger: string
  content: string
  createdAt: number
}

export interface AppRuleInput {
  match: string
  tone: AppRule['tone']
  formatting?: AppRule['formatting']
  trailingSpace?: boolean
  instructions?: string
  createdAt: number
}

/** The optional per-app overrides, copied only when set so `undefined` never reaches the wire. */
const APP_RULE_OPTIONALS = ['formatting', 'trailingSpace', 'instructions'] as const

/**
 * The style preferences that follow the user across devices. The wire keeps the model
 * instructions under `llmInstructions` (older clients read that name); locally they live at
 * `formatting.instructions`. Fields older clients still send (fillers, hesitations, lists,
 * numbers, ...) are ignored on the way in and never written on the way out.
 */
export interface SyncedFormatting {
  mode: Settings['formatting']['mode']
  tone: Settings['formatting']['tone']
  trailingSpace: boolean
  llmInstructions: string
}

export interface SyncedPreferences {
  formatting: SyncedFormatting
  language: string
  sync: { history: boolean }
}

/** Partial preferences as stored on the server (every field optional). */
export interface RemotePreferences {
  formatting?: Partial<SyncedFormatting>
  language?: string
  sync?: { history?: boolean }
  updatedAt?: number
}

export interface HistoryPushEntry {
  entryId: string
  createdAt: number
  mode: HistoryEntry['mode']
  rawText?: string
  finalText: string
  wordCount: number
  speechMs: number
  appName?: string
  provider: string
  model: string
  llmUsed: boolean
}

export type CollectionName = 'dictionary' | 'snippets' | 'appRules'

export type OutboxOp =
  | {
      id: string
      kind: 'dictionary.upsert'
      localId: string
      remoteId?: string
      acked?: boolean
      entry: DictionaryInput
    }
  | { id: string; kind: 'dictionary.remove'; remoteId: string }
  | {
      id: string
      kind: 'snippets.upsert'
      localId: string
      remoteId?: string
      acked?: boolean
      snippet: SnippetInput
    }
  | { id: string; kind: 'snippets.remove'; remoteId: string }
  | {
      id: string
      kind: 'appRules.upsert'
      localId: string
      remoteId?: string
      acked?: boolean
      rule: AppRuleInput
    }
  | { id: string; kind: 'appRules.remove'; remoteId: string }
  | { id: string; kind: 'preferences.update'; patch: RemotePreferences }
  | {
      id: string
      kind: 'stats.record'
      sessionId: string
      words: number
      speechMs: number
      day: string
    }
  | { id: string; kind: 'history.push'; entries: HistoryPushEntry[] }
  | { id: string; kind: 'history.remove'; entryId: string }
  | { id: string; kind: 'history.clear' }
  | { id: string; kind: 'users.completeOnboarding'; version: number }

export type UpsertOp = Extract<OutboxOp, { localId: string }>

export interface RemoteRecord {
  id: string
  createdAt: number
  updatedAt: number
}

export type RemoteDictionaryEntry = RemoteRecord & Omit<DictionaryInput, 'createdAt'>
export type RemoteSnippet = RemoteRecord & Omit<SnippetInput, 'createdAt'>
export type RemoteAppRule = RemoteRecord & Omit<AppRuleInput, 'createdAt'>

export interface RemoteStats {
  totalWords: number
  totalSessions: number
  totalSpeechMs: number
  streakDays: number
  lastSessionDay: string
}

export interface RemoteHistoryEntry extends HistoryPushEntry {
  deviceId: string
  deviceName?: string
}

// ---- collections -----------------------------------------------------------------------------

export function dictionaryFromRemote(remote: RemoteDictionaryEntry): DictionaryEntry {
  return {
    id: remote.id,
    word: remote.word,
    aliases: remote.aliases,
    fuzzy: remote.fuzzy,
    createdAt: remote.createdAt
  }
}

export function snippetFromRemote(remote: RemoteSnippet): Snippet {
  return {
    id: remote.id,
    trigger: remote.trigger,
    content: remote.content,
    createdAt: remote.createdAt
  }
}

type AppRuleOverrides = Partial<Pick<AppRule, (typeof APP_RULE_OPTIONALS)[number]>>

function copyOptionals<T extends object>(from: AppRuleOverrides, to: T): T & AppRuleOverrides {
  const out: T & AppRuleOverrides = { ...to }
  for (const key of APP_RULE_OPTIONALS) {
    const value = from[key]
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

export function appRuleFromRemote(remote: RemoteAppRule): AppRule {
  return copyOptionals(remote, { id: remote.id, match: remote.match, tone: remote.tone })
}

export function dictionaryToInput(entry: DictionaryEntry): DictionaryInput {
  return {
    word: entry.word,
    aliases: [...entry.aliases],
    fuzzy: entry.fuzzy,
    createdAt: entry.createdAt || Date.now()
  }
}

export function snippetToInput(snippet: Snippet): SnippetInput {
  return {
    trigger: snippet.trigger,
    content: snippet.content,
    createdAt: snippet.createdAt || Date.now()
  }
}

export function appRuleToInput(rule: AppRule, createdAt: number): AppRuleInput {
  return copyOptionals(rule, { match: rule.match, tone: rule.tone, createdAt })
}

export type RemoveKind = 'dictionary.remove' | 'snippets.remove' | 'appRules.remove'

interface CollectionSpec<Local extends { id: string }, Remote extends RemoteRecord> {
  upsertKind: UpsertOp['kind']
  removeKind: RemoveKind
  fromRemote: (remote: Remote) => Local
  fromOp: (op: UpsertOp, id: string) => Local
  /** Omitted to keep server order (plus local additions at the end). */
  sort?: (a: Local, b: Local) => number
}

export const dictionarySpec: CollectionSpec<DictionaryEntry, RemoteDictionaryEntry> = {
  upsertKind: 'dictionary.upsert',
  removeKind: 'dictionary.remove',
  fromRemote: dictionaryFromRemote,
  fromOp: (op, id) => {
    if (op.kind !== 'dictionary.upsert') throw new Error('wrong op')
    return { id, ...op.entry, aliases: [...op.entry.aliases] }
  },
  sort: (a, b) => b.createdAt - a.createdAt
}

export const snippetsSpec: CollectionSpec<Snippet, RemoteSnippet> = {
  upsertKind: 'snippets.upsert',
  removeKind: 'snippets.remove',
  fromRemote: snippetFromRemote,
  fromOp: (op, id) => {
    if (op.kind !== 'snippets.upsert') throw new Error('wrong op')
    return { id, ...op.snippet }
  },
  sort: (a, b) => b.createdAt - a.createdAt
}

/** App rules keep the user's ordering (oldest first), matching the Style page. */
export const appRulesSpec: CollectionSpec<AppRule, RemoteAppRule> = {
  upsertKind: 'appRules.upsert',
  removeKind: 'appRules.remove',
  fromRemote: appRuleFromRemote,
  fromOp: (op, id) => {
    if (op.kind !== 'appRules.upsert') throw new Error('wrong op')
    return copyOptionals(op.rule, { id, match: op.rule.match, tone: op.rule.tone })
  }
}

/**
 * Server snapshot + pending local operations -> what the app should show. Until the first snapshot
 * arrives the local mirror is left untouched, so dictation keeps working offline.
 */
export function deriveCollection<Local extends { id: string }, Remote extends RemoteRecord>(
  spec: CollectionSpec<Local, Remote>,
  server: readonly Remote[] | null,
  local: readonly Local[],
  ops: readonly OutboxOp[]
): Local[] {
  if (server === null) return [...local]
  const byId = new Map<string, Local>()
  const order: string[] = []
  for (const remote of server) {
    byId.set(remote.id, spec.fromRemote(remote))
    order.push(remote.id)
  }
  const serverIds = new Set(order)
  for (const op of ops) {
    if (op.kind === spec.upsertKind && 'localId' in op) {
      if (op.acked && op.remoteId && serverIds.has(op.remoteId)) continue
      const id = op.remoteId ?? op.localId
      if (op.remoteId && op.remoteId !== op.localId) byId.delete(op.localId)
      order.push(id)
      byId.set(id, spec.fromOp(op, id))
    } else if (op.kind === spec.removeKind && 'remoteId' in op) {
      byId.delete(op.remoteId)
    }
  }
  const seen = new Set<string>()
  const out: Local[] = []
  for (const id of order) {
    if (seen.has(id)) continue
    seen.add(id)
    const item = byId.get(id)
    if (item) out.push(item)
  }
  return spec.sort ? out.sort(spec.sort) : out
}

export interface CollectionDiff<T> {
  added: T[]
  changed: T[]
  removed: T[]
}

export function diffCollection<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  equal: (a: T, b: T) => boolean
): CollectionDiff<T> {
  const prevById = new Map(previous.map((item) => [item.id, item]))
  const nextIds = new Set(next.map((item) => item.id))
  const diff: CollectionDiff<T> = { added: [], changed: [], removed: [] }
  for (const item of next) {
    const before = prevById.get(item.id)
    if (!before) diff.added.push(item)
    else if (!equal(before, item)) diff.changed.push(item)
  }
  for (const item of previous) if (!nextIds.has(item.id)) diff.removed.push(item)
  return diff
}

export const sameDictionaryEntry = (a: DictionaryEntry, b: DictionaryEntry): boolean =>
  a.word === b.word && a.fuzzy === b.fuzzy && a.aliases.join('\u0000') === b.aliases.join('\u0000')

export const sameSnippet = (a: Snippet, b: Snippet): boolean =>
  a.trigger === b.trigger && a.content === b.content

export const sameAppRule = (a: AppRule, b: AppRule): boolean =>
  a.match === b.match && a.tone === b.tone && APP_RULE_OPTIONALS.every((key) => a[key] === b[key])

/**
 * Add an upsert for `localId`, replacing any unsent upsert for the same item. `remoteId` is the
 * server id when the item is already known to the server (so it is updated in place).
 */
export function queueUpsert(ops: OutboxOp[], op: UpsertOp): OutboxOp[] {
  const kept = ops.filter(
    (existing) =>
      !(
        existing.kind === op.kind &&
        'localId' in existing &&
        existing.localId === op.localId &&
        !existing.acked
      )
  )
  return [...kept, op]
}

/**
 * Add a removal. An unsent creation of the same item is simply dropped (nothing to delete
 * remotely); otherwise the server record is deleted.
 */
export function queueRemove(
  ops: OutboxOp[],
  upsertKind: UpsertOp['kind'],
  removeKind: RemoveKind,
  localId: string,
  remoteId: string | undefined,
  opId: string
): OutboxOp[] {
  const pending = ops.find(
    (op): op is UpsertOp => op.kind === upsertKind && 'localId' in op && op.localId === localId
  )
  const target = remoteId ?? pending?.remoteId
  const kept = ops.filter(
    (op) => !(op.kind === upsertKind && 'localId' in op && op.localId === localId)
  )
  if (!target) return kept
  return [...kept, { id: opId, kind: removeKind, remoteId: target }]
}

/** After the server confirms an upsert, remember its id and keep it until the snapshot echoes it. */
export function ackUpsert(ops: OutboxOp[], opId: string, remoteId: string): OutboxOp[] {
  return ops.map((op) =>
    op.id === opId && 'localId' in op ? { ...op, remoteId, acked: true } : op
  )
}

/** Drop acknowledged upserts once the server snapshot contains them. */
export function pruneAcked(ops: OutboxOp[], serverIds: ReadonlySet<string>): OutboxOp[] {
  return ops.filter(
    (op) => !('localId' in op && op.acked && op.remoteId && serverIds.has(op.remoteId))
  )
}

// ---- preferences -----------------------------------------------------------------------------

export function extractPreferences(s: Settings): SyncedPreferences {
  const f = s.formatting
  return {
    formatting: {
      mode: f.mode,
      tone: f.tone,
      trailingSpace: f.trailingSpace,
      llmInstructions: f.instructions
    },
    language: s.stt.language,
    sync: { history: s.cloud.historySync }
  }
}

export function samePreferences(a: SyncedPreferences, b: SyncedPreferences): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Only the sections that changed are sent, so a phone-side edit to tone is never clobbered. */
export function preferencesPatch(
  prev: SyncedPreferences,
  next: SyncedPreferences
): RemotePreferences {
  const patch: RemotePreferences = {}
  if (JSON.stringify(prev.formatting) !== JSON.stringify(next.formatting))
    patch.formatting = next.formatting
  if (prev.language !== next.language) patch.language = next.language
  if (prev.sync.history !== next.sync.history) patch.sync = { history: next.sync.history }
  return patch
}

export function mergePreferencePatches(
  a: RemotePreferences,
  b: RemotePreferences
): RemotePreferences {
  return {
    ...(a.formatting || b.formatting
      ? { formatting: { ...(a.formatting ?? {}), ...(b.formatting ?? {}) } }
      : {}),
    ...(b.language !== undefined
      ? { language: b.language }
      : a.language !== undefined
        ? { language: a.language }
        : {}),
    ...(a.sync || b.sync ? { sync: { ...(a.sync ?? {}), ...(b.sync ?? {}) } } : {})
  }
}

/** A settings patch for the `formatting` section. */
export type FormattingPatch = Partial<
  Pick<Settings['formatting'], 'mode' | 'tone' | 'trailingSpace' | 'instructions'>
>

/** Wire shape -> settings shape. */
export function toFormattingPatch(flat: Partial<SyncedFormatting>): FormattingPatch {
  const out: FormattingPatch = {}
  if (flat.mode !== undefined) out.mode = flat.mode
  if (flat.tone !== undefined) out.tone = flat.tone
  if (flat.trailingSpace !== undefined) out.trailingSpace = flat.trailingSpace
  if (flat.llmInstructions !== undefined) out.instructions = flat.llmInstructions
  return out
}

/**
 * Remote preferences (plus any unsent local patch) applied over the current settings. Fields the
 * server has never seen keep their local value.
 */
export function applyRemotePreferences(
  s: Settings,
  remote: RemotePreferences | null,
  pending: RemotePreferences | null
): {
  formatting: FormattingPatch
  stt: { language: string }
  cloud: { historySync: boolean }
} {
  const merged = mergePreferencePatches(remote ?? {}, pending ?? {})
  const current = extractPreferences(s)
  const flat: Partial<SyncedFormatting> = {}
  for (const key of Object.keys(current.formatting) as Array<keyof SyncedFormatting>) {
    const value = merged.formatting?.[key]
    if (value !== undefined) (flat as Record<string, unknown>)[key] = value
  }
  return {
    formatting: toFormattingPatch(flat),
    stt: { language: merged.language ?? current.language },
    cloud: { historySync: merged.sync?.history ?? current.sync.history }
  }
}

// ---- stats -----------------------------------------------------------------------------------

export function deriveStats(
  local: Settings['stats'],
  server: RemoteStats | null,
  ops: readonly OutboxOp[]
): Settings['stats'] {
  if (!server) return { ...local }
  const pending = ops.filter(
    (op): op is Extract<OutboxOp, { kind: 'stats.record' }> => op.kind === 'stats.record'
  )
  const out = {
    totalWords: server.totalWords,
    totalSessions: server.totalSessions,
    totalSpeechMs: server.totalSpeechMs,
    streakDays: Math.max(server.streakDays, pending.length ? local.streakDays : 0),
    lastSessionDay:
      pending.length && local.lastSessionDay > server.lastSessionDay
        ? local.lastSessionDay
        : server.lastSessionDay
  }
  for (const op of pending) {
    out.totalWords += op.words
    out.totalSessions += 1
    out.totalSpeechMs += op.speechMs
  }
  return out
}

// ---- history ---------------------------------------------------------------------------------

export function historyToPush(entry: HistoryEntry): HistoryPushEntry | null {
  if (!entry.finalText.trim() || entry.error) return null
  return {
    entryId: entry.id,
    createdAt: entry.createdAt,
    mode: entry.mode,
    rawText: entry.rawText || undefined,
    finalText: entry.finalText,
    wordCount: entry.wordCount,
    speechMs: entry.speechMs,
    appName: entry.appName,
    provider: entry.provider,
    model: entry.model,
    llmUsed: entry.llmUsed
  }
}

export function historyFromRemote(remote: RemoteHistoryEntry): HistoryEntry {
  return {
    id: remote.entryId,
    createdAt: remote.createdAt,
    mode: remote.mode,
    rawText: remote.rawText ?? '',
    finalText: remote.finalText,
    wordCount: remote.wordCount,
    speechMs: remote.speechMs,
    appName: remote.appName,
    provider: remote.provider,
    model: remote.model,
    injected: true,
    llmUsed: remote.llmUsed,
    timings: {
      recordMs: remote.speechMs,
      vadMs: 0,
      sttMs: 0,
      formatMs: 0,
      llmMs: 0,
      injectMs: 0,
      totalMs: 0
    },
    deviceId: remote.deviceId,
    deviceName: remote.deviceName,
    remote: true
  }
}

/** Append to the trailing push op when possible so a burst of dictations becomes one request. */
export function queueHistoryPush(
  ops: OutboxOp[],
  entry: HistoryPushEntry,
  opId: string,
  maxBatch = 100
): OutboxOp[] {
  const last = ops[ops.length - 1]
  if (last && last.kind === 'history.push' && last.entries.length < maxBatch) {
    return [...ops.slice(0, -1), { ...last, entries: [...last.entries, entry] }]
  }
  return [...ops, { id: opId, kind: 'history.push', entries: [entry] }]
}

/** Local calendar day as YYYY-MM-DD, matching the desktop stats implementation. */
export function localDay(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
