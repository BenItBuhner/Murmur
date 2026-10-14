import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { ConvexClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import type { Id } from '@backend/_generated/dataModel'
import {
  ONBOARDING_VERSION,
  currentUtcDay,
  msUntilNextUtcDay,
  type CloudConfig,
  type CloudDevice,
  type CloudUser,
  type InferenceStatus,
  type PlanState,
  type RendererAuthState,
  type SyncPhase,
  type SyncStatus
} from '@shared/cloud'
import type { AppRule, DictionaryEntry, Settings, Snippet } from '@shared/settings'
import type { HistoryEntry } from '@shared/types'
import { createLogger } from '../logger'
import type { HistoryStore } from '../store/history'
import type { SettingsPatch, SettingsStore } from '../store/settings'
import { api } from './api'
import { Outbox } from './outbox'
import type { TokenBridge } from './token-bridge'
import {
  ackUpsert,
  appRuleToInput,
  appRulesSpec,
  applyRemotePreferences,
  deriveCollection,
  deriveStats,
  dictionarySpec,
  dictionaryToInput,
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
  retryDelayMs,
  sameAppRule,
  sameDictionaryEntry,
  samePreferences,
  sameSnippet,
  snippetToInput,
  snippetsSpec,
  type OutboxOp,
  type RemoteAppRule,
  type RemoteDictionaryEntry,
  type RemoteHistoryEntry,
  type RemotePreferences,
  type RemoteSnippet,
  type RemoteStats,
  type SyncedPreferences
} from './reducers'

const log = createLogger('cloud:sync')

const HEARTBEAT_MS = 15 * 60_000
const RETRY_MS = 15_000
/**
 * An op that failed this many times in a row while connected is dropped: something about it is
 * wrong that a retry will not fix, and it must not hold the rest of the queue hostage forever.
 */
const MAX_ATTEMPTS = 8
/** Local history pushed when sync is first turned on (the server keeps its own cap). */
const HISTORY_BACKLOG = 200
/** Entries per history fetch: the newest page first, then only what is new since the cursor. */
const HISTORY_PAGE = 20
const HISTORY_MAX_PAGES = 10
/** Finished dictations sent per `stats.recordMany` call. */
const STATS_BATCH = 50
/** Quiet time after a burst of dictations before the status and history are asked again. */
const STATUS_REFRESH_DEBOUNCE_MS = 30_000
const HISTORY_FETCH_DEBOUNCE_MS = 2_000
const IMPORT_CHUNK = 500

/**
 * The account's managed-model status. It takes the client's UTC calendar day so the instance can
 * compute the rolling windows (words this week, dictations today) and their reset times; spelled
 * out here with the contract's shape because the committed generated API predates the argument.
 * An instance that does not know the argument yet gets the plain call (see `refreshStatus`).
 */
const inferenceStatus = makeFunctionReference<'query', { day?: string }, InferenceStatus>(
  'inference:status'
)

type Platform = 'win32' | 'darwin' | 'linux'

/** Structural views of the stores so the engine can be exercised outside Electron. */
export type SettingsSource = Pick<SettingsStore, 'get' | 'patch' | 'on' | 'off'>
export type HistorySource = Pick<
  HistoryStore,
  'on' | 'off' | 'list' | 'mergeRemote' | 'appendRemote' | 'removeRemote' | 'replaceAll'
>
export type TokenSource = Pick<TokenBridge, 'request'>

export interface SyncDeps {
  config: CloudConfig
  settings: SettingsSource
  history: HistorySource
  tokenBridge: TokenSource
  userDataPath: string
  appVersion: string
  platform: NodeJS.Platform
}

interface ServerState {
  user: CloudUser | null | undefined
  dictionary: RemoteDictionaryEntry[] | null
  snippets: RemoteSnippet[] | null
  appRules: RemoteAppRule[] | null
  preferences: RemotePreferences | null | undefined
  stats: RemoteStats | null | undefined
  devices: CloudDevice[] | null
  inference: InferenceStatus | null
}

interface Mirror {
  dictionary: DictionaryEntry[]
  snippets: Snippet[]
  appRules: AppRule[]
  prefs: SyncedPreferences
}

const emptyServer = (): ServerState => ({
  user: undefined,
  dictionary: null,
  snippets: null,
  appRules: null,
  preferences: undefined,
  stats: undefined,
  devices: null,
  inference: null
})

const snapshot = (s: Settings): Mirror => ({
  dictionary: s.dictionary.map((e) => ({ ...e, aliases: [...e.aliases] })),
  snippets: s.snippets.map((x) => ({ ...x })),
  appRules: s.formatting.appRules.map((r) => ({ ...r })),
  prefs: extractPreferences(s)
})

const ZERO_STATS: Settings['stats'] = {
  totalWords: 0,
  totalSessions: 0,
  totalSpeechMs: 0,
  streakDays: 0,
  lastSessionDay: ''
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.message.replace(/^\[CONVEX [^\]]+\]\s*(\[Request ID: [^\]]+\]\s*)?/i, '')
  return String(err)
}

/**
 * Errors the server will keep returning for the same input (validation, ownership, limits). Retrying
 * them would wedge the queue, so the operation is dropped and the server state wins.
 */
function isPermanentError(err: unknown): boolean {
  if (err instanceof ConvexError) return true
  if (!(err instanceof Error)) return false
  if (/Not authenticated/i.test(err.message)) return false
  return /Server Error|ArgumentValidationError|Uncaught Error|ReturnsValidationError/i.test(
    err.message
  )
}

function toCloudUser(u: {
  id: string
  clerkId: string
  email?: string
  name?: string
  imageUrl?: string
  plan: CloudUser['plan']
  onboardingCompletedAt?: number
  onboardingVersion?: number
}): CloudUser {
  // Plan states arrive from an instance that meters plans; the committed API types predate them.
  const extra = u as { planState?: unknown; trialEndsAt?: unknown }
  const planState =
    extra.planState === 'trial' || extra.planState === 'free' || extra.planState === 'pro'
      ? (extra.planState as PlanState)
      : undefined
  return {
    id: u.id,
    clerkId: u.clerkId,
    email: u.email,
    name: u.name,
    imageUrl: u.imageUrl,
    plan: u.plan,
    planState,
    trialEndsAt: typeof extra.trialEndsAt === 'number' ? extra.trialEndsAt : undefined,
    onboardingCompletedAt: u.onboardingCompletedAt,
    onboardingVersion: u.onboardingVersion
  }
}

/** A function the instance does not have yet (an older backend): fall back to the old call. */
function isMissingFunction(err: unknown): boolean {
  return err instanceof Error && /Could not find public function/i.test(err.message)
}

/**
 * Keeps this device's local mirror in step with the account's data in Convex.
 *
 * - Clerk (in the renderer) reports who is signed in; the Convex WebSocket is authenticated with
 *   tokens fetched through the TokenBridge.
 * - Server snapshots arrive through subscriptions. Local edits are diffed into idempotent operations
 *   in a persisted outbox and replayed in order. The settings the dictation pipeline reads are always
 *   `derive(server snapshot, pending ops)`, so the app is fully usable offline.
 * - A device that had local data before it had an account merges that data into the account the
 *   first time it signs in.
 */
export class CloudSync extends EventEmitter {
  private client: ConvexClient | null = null
  private readonly outbox: Outbox
  private server = emptyServer()
  private subscriptions: Array<() => void> = []
  /** History sync is on and fetched on demand (no live subscription; see `fetchHistory`). */
  private historyActive = false
  /** Server insertion time of the newest remote entry this device has (`history.since`). */
  private historyCursor: number | undefined
  private historyFetching = false
  private historyAgain = false
  private historyTimer: NodeJS.Timeout | null = null
  /** The instance predates `history.since` / `stats.recordMany`: use the old calls. */
  private legacyHistory = false
  private legacyStats = false
  /** The instance predates `bootstrap.get`: hold the seven live subscriptions instead. */
  private legacyBootstrap = false
  private bootstrapFetching = false
  private bootstrapAgain = false
  private lastBootstrapAt = 0
  private statusDayTimer: NodeJS.Timeout | null = null
  private statusRefreshTimer: NodeJS.Timeout | null = null
  /** Consecutive failed flushes, for the backoff; reset by any success. */
  private flushFailures = 0
  /** Failed attempts per op id while connected (in memory: a restart gives every op a fresh start). */
  private readonly attempts = new Map<string, number>()
  /** The instance rejected the `day` argument: an older backend, asked the old way from then on. */
  private statusWithoutDay = false
  private connectionUnsub: (() => void) | null = null
  private auth: RendererAuthState = { signedIn: false }
  private authenticated = false
  private connected = false
  private error: string | undefined
  private lastSyncedAt: number | undefined
  private flushing = false
  private flushTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private applying = false
  private mirror: Mirror
  private generation = 0
  private disposed = false

  constructor(private readonly deps: SyncDeps) {
    super()
    this.outbox = new Outbox(deps.userDataPath)
    this.ensureDeviceIdentity()
    this.mirror = snapshot(deps.settings.get())
  }

  get enabled(): boolean {
    return this.deps.config.accountMode !== 'off'
  }

  get deviceId(): string {
    return this.deps.settings.get().cloud.deviceId
  }

  start(): void {
    if (!this.enabled || this.client) return
    const ws = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!ws) {
      this.error = 'WebSocket is not available in this runtime'
      log.error(this.error)
      this.emitStatus()
      return
    }
    this.client = new ConvexClient(this.deps.config.convexUrl, {
      webSocketConstructor: ws,
      skipConvexDeploymentUrlCheck: true,
      unsavedChangesWarning: false,
      logger: {
        logVerbose: (...args: unknown[]) => log.debug(args.map(String).join(' ')),
        log: (...args: unknown[]) => log.debug(args.map(String).join(' ')),
        warn: (...args: unknown[]) => log.warn(args.map(String).join(' ')),
        error: (...args: unknown[]) => log.error(args.map(String).join(' '))
      }
    })
    this.connectionUnsub = this.client.subscribeToConnectionState((state) => {
      const was = this.connected
      this.connected = state.isWebSocketConnected
      if (this.connected !== was) {
        log.info(this.connected ? 'connected to Convex' : 'disconnected from Convex')
      }
      if (this.connected && !was) {
        this.error = undefined
        this.flushFailures = 0
        this.scheduleFlush(0)
      }
      this.emitStatus()
    })
    this.deps.settings.on('change', this.onSettingsChange)
    this.deps.history.on('added', this.onHistoryAdded)
    // A failed dictation sent again and now transcribed is new text for the account too.
    this.deps.history.on('replaced', this.onHistoryAdded)
    this.deps.history.on('deleted', this.onHistoryDeleted)
    this.deps.history.on('cleared', this.onHistoryCleared)
    log.info(
      `sync engine started (${this.deps.config.accountMode} mode, ${this.deps.config.convexUrl})`
    )
    this.emitStatus()
  }

  // ---- auth --------------------------------------------------------------------------------

  /** Called whenever the renderer's Clerk session changes. */
  setAuthState(state: RendererAuthState): void {
    if (!this.enabled) return
    const previous = this.auth
    this.auth = state
    if (state.signedIn && state.userId) {
      if (!previous.signedIn || previous.userId !== state.userId) this.connectAccount(state.userId)
      else this.emitStatus()
      return
    }
    if (previous.signedIn) {
      log.info('signed out; clearing account data from this device')
      this.disconnectAccount(true)
    } else {
      this.emitStatus()
    }
  }

  private connectAccount(userId: string): void {
    if (!this.client) return
    this.generation++
    const generation = this.generation
    this.server = emptyServer()
    this.outbox.bind(userId)
    this.deps.settings.patch({ cloud: { lastSignedInUserId: userId } }, 'cloud')
    this.mirror = snapshot(this.deps.settings.get())
    log.info(`connecting account ${userId.slice(0, 12)}…`)
    this.client.setAuth(
      ({ forceRefreshToken }) => this.deps.tokenBridge.request(forceRefreshToken),
      (isAuthenticated) => {
        if (generation !== this.generation) return
        this.authenticated = isAuthenticated
        if (isAuthenticated) void this.onAuthenticated(userId, generation)
        else this.emitStatus()
      }
    )
    this.emitStatus()
  }

  private disconnectAccount(wipe: boolean): void {
    this.generation++
    this.stopSubscriptions()
    this.stopHeartbeat()
    this.client?.client.clearAuth()
    this.authenticated = false
    this.server = emptyServer()
    this.error = undefined
    if (wipe) {
      this.outbox.clear()
      this.deps.settings.patch(
        {
          dictionary: [],
          snippets: [],
          formatting: { appRules: [] },
          stats: { ...ZERO_STATS },
          cloud: { lastSignedInUserId: '', historySync: false }
        },
        'cloud'
      )
      this.deps.history.replaceAll([], 'cloud')
    }
    this.mirror = snapshot(this.deps.settings.get())
    this.emitStatus()
  }

  private async onAuthenticated(userId: string, generation: number): Promise<void> {
    const client = this.client
    if (!client) return
    try {
      const user = await client.mutation(api.users.ensure, {})
      if (generation !== this.generation) return
      this.server.user = toCloudUser(user)
      this.emitStatus()
      await this.heartbeat()
      await this.importLocalData(userId, generation)
      if (generation !== this.generation) return
      this.fetchBootstrap(generation)
      this.refreshStatus(generation)
      this.updateHistorySubscription(generation)
      this.startHeartbeat()
      this.error = undefined
      this.scheduleFlush(0)
    } catch (err) {
      if (generation !== this.generation) return
      this.error = errorMessage(err)
      log.error('account connection failed; will retry', err)
      setTimeout(() => {
        if (generation === this.generation && this.authenticated)
          void this.onAuthenticated(userId, generation)
      }, RETRY_MS)
    }
    this.emitStatus()
  }

  // ---- first sign-in merge -----------------------------------------------------------------

  private async importLocalData(userId: string, generation: number): Promise<void> {
    const client = this.client
    if (!client) return
    const s = this.deps.settings.get()
    if (s.cloud.importedForUserId === userId) return
    log.info(
      `merging local data into account: ${s.dictionary.length} words, ${s.snippets.length} snippets, ${s.formatting.appRules.length} rules`
    )
    for (const part of chunk(s.dictionary, IMPORT_CHUNK)) {
      await client.mutation(api.dictionary.importMany, {
        entries: part.map((e) => ({
          word: e.word,
          aliases: e.aliases,
          fuzzy: e.fuzzy,
          createdAt: e.createdAt || undefined
        }))
      })
    }
    for (const part of chunk(s.snippets, IMPORT_CHUNK)) {
      await client.mutation(api.snippets.importMany, {
        snippets: part.map((x) => ({
          trigger: x.trigger,
          content: x.content,
          createdAt: x.createdAt || undefined
        }))
      })
    }
    for (const part of chunk(s.formatting.appRules, IMPORT_CHUNK)) {
      await client.mutation(api.appRules.importMany, {
        rules: part.map((r) => ({
          match: r.match,
          tone: r.tone,
          formatting: r.formatting,
          trailingSpace: r.trailingSpace,
          instructions: r.instructions,
          speed: r.speed
        }))
      })
    }
    if (s.stats.totalSessions > 0) {
      await client.mutation(api.stats.importLocal, {
        totalWords: s.stats.totalWords,
        totalSessions: s.stats.totalSessions,
        totalSpeechMs: s.stats.totalSpeechMs,
        streakDays: s.stats.streakDays,
        lastSessionDay: s.stats.lastSessionDay
      })
    }
    const remotePrefs = await client.query(api.preferences.get, {})
    if (!remotePrefs) {
      const local = extractPreferences(s)
      await client.mutation(api.preferences.update, {
        formatting: local.formatting,
        language: local.language,
        sync: local.sync
      })
    }
    if (s.onboardingComplete) {
      // The device was set up before the account existed; do not send this user through
      // account-level onboarding again.
      await client.mutation(api.users.completeOnboarding, { version: ONBOARDING_VERSION })
    }
    if (generation !== this.generation) return
    this.deps.settings.patch({ cloud: { importedForUserId: userId } }, 'cloud')
    this.mirror = snapshot(this.deps.settings.get())
  }

  // ---- the account snapshot ------------------------------------------------------------------

  /** Quiet time after a bootstrap fetch before a focus event asks for another. */
  private static readonly BOOTSTRAP_FOCUS_DEBOUNCE_MS = 15_000

  /**
   * Everything the account holds, in one answer (see backend `bootstrap.get`). Fetched on connect,
   * when the app comes to the front, after the outbox drains and on Sync now, and cached in the
   * server mirror — instead of seven live subscriptions that each re-read and re-sent their whole
   * result after every write they could see, which was most of Murmur's function-call load on the
   * Convex free plan. An instance from before the endpoint falls back to those subscriptions.
   */
  private fetchBootstrap(generation = this.generation): void {
    const client = this.client
    if (!client || !this.authenticated || this.legacyBootstrap) return
    void this.doFetchBootstrap(generation)
  }

  private async doFetchBootstrap(generation: number): Promise<void> {
    const client = this.client
    if (!client || !this.authenticated) return
    if (this.bootstrapFetching) {
      this.bootstrapAgain = true
      return
    }
    this.bootstrapFetching = true
    try {
      const boot = await client.query(api.bootstrap.get, {})
      if (generation !== this.generation) return
      this.lastBootstrapAt = Date.now()
      this.applyBootstrap(boot)
    } catch (err) {
      if (generation !== this.generation) return
      if (isMissingFunction(err)) {
        log.info('instance has no bootstrap.get; falling back to live subscriptions')
        this.legacyBootstrap = true
        this.legacySubscribeAll(generation)
        return
      }
      this.error = errorMessage(err)
      log.warn(`bootstrap fetch failed: ${this.error}`)
      this.emitStatus()
    } finally {
      this.bootstrapFetching = false
      if (this.bootstrapAgain && generation === this.generation) {
        this.bootstrapAgain = false
        void this.doFetchBootstrap(generation)
      }
    }
  }

  /** One answer applied: the same writes the seven subscriptions made, minus the re-runs. */
  private applyBootstrap(boot: FunctionReturnType<typeof api.bootstrap.get>): void {
    const prevUser = this.server.user
    const prevStats = this.server.stats
    this.server.user = boot.me ? toCloudUser(boot.me) : null
    this.server.preferences = boot.preferences
    this.server.dictionary = boot.dictionary
    this.outbox.update((ops) => pruneAcked(ops, new Set(boot.dictionary.map((x) => x.id))))
    this.server.snippets = boot.snippets
    this.outbox.update((ops) => pruneAcked(ops, new Set(boot.snippets.map((x) => x.id))))
    this.server.appRules = boot.appRules
    this.outbox.update((ops) => pruneAcked(ops, new Set(boot.appRules.map((x) => x.id))))
    this.server.stats = boot.stats
    const mine = this.deviceId
    this.server.devices = boot.devices.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
      current: d.deviceId === mine
    }))
    this.lastSyncedAt = Date.now()
    this.applyDerived()
    this.emitStatus()
    // The cues the subscriptions carried:
    // A plan or trial change moves the allowance: ask for the status again.
    const u = boot.me
    if (prevUser && u && (prevUser.plan !== u.plan || prevUser.trialEndsAt !== u.trialEndsAt))
      this.scheduleStatusRefresh(0)
    // Stats move when any device finishes a dictation: the cue to look for new history,
    // instead of keeping a 200-entry history query live on every device.
    if (prevStats !== undefined && boot.stats?.totalSessions !== prevStats?.totalSessions) {
      this.scheduleHistoryFetch(HISTORY_FETCH_DEBOUNCE_MS)
      this.scheduleStatusRefresh(STATUS_REFRESH_DEBOUNCE_MS)
    }
  }

  /**
   * The app window gained focus (or the system woke): the account snapshot may be stale by now,
   * so ask for it again — unless one arrived moments ago, or the account is not connected.
   */
  onAppFocus(): void {
    if (!this.enabled || !this.authenticated) return
    if (Date.now() - this.lastBootstrapAt < CloudSync.BOOTSTRAP_FOCUS_DEBOUNCE_MS) return
    this.fetchBootstrap()
  }

  // ---- legacy subscriptions ------------------------------------------------------------------

  /** From before `bootstrap.get`: the seven live subscriptions this engine used to hold. */
  private legacySubscribeAll(generation: number): void {
    const client = this.client
    if (!client) return
    this.stopSubscriptions()
    const guard =
      <T>(apply: (value: T) => void) =>
      (value: T) => {
        if (generation !== this.generation) return
        apply(value)
        this.lastSyncedAt = Date.now()
        this.applyDerived()
        this.emitStatus()
      }
    const onError = (err: Error): void => {
      if (generation !== this.generation) return
      this.error = errorMessage(err)
      log.warn(`subscription error: ${this.error}`)
      this.emitStatus()
    }
    this.subscriptions.push(
      client.onUpdate(
        api.users.me,
        {},
        guard((u) => {
          const before = this.server.user
          this.server.user = u ? toCloudUser(u) : null
          // A plan or trial change moves the allowance: ask for the status again.
          if (before && u && (before.plan !== u.plan || before.trialEndsAt !== u.trialEndsAt))
            this.scheduleStatusRefresh(0)
        }),
        onError
      ),
      client.onUpdate(
        api.dictionary.list,
        {},
        guard((list) => {
          this.server.dictionary = list
          this.outbox.update((ops) => pruneAcked(ops, new Set(list.map((x) => x.id))))
        }),
        onError
      ),
      client.onUpdate(
        api.snippets.list,
        {},
        guard((list) => {
          this.server.snippets = list
          this.outbox.update((ops) => pruneAcked(ops, new Set(list.map((x) => x.id))))
        }),
        onError
      ),
      client.onUpdate(
        api.appRules.list,
        {},
        guard((list) => {
          this.server.appRules = list
          this.outbox.update((ops) => pruneAcked(ops, new Set(list.map((x) => x.id))))
        }),
        onError
      ),
      client.onUpdate(
        api.preferences.get,
        {},
        guard((p) => (this.server.preferences = p)),
        onError
      ),
      client.onUpdate(
        api.stats.get,
        {},
        guard((st) => {
          // Stats move when any device finishes a dictation: the cue to look for new history,
          // instead of keeping a 200-entry history query live on every device.
          const moved =
            this.server.stats !== undefined &&
            st?.totalSessions !== this.server.stats?.totalSessions
          this.server.stats = st
          if (moved) {
            this.scheduleHistoryFetch(HISTORY_FETCH_DEBOUNCE_MS)
            this.scheduleStatusRefresh(STATUS_REFRESH_DEBOUNCE_MS)
          }
        }),
        onError
      ),
      client.onUpdate(
        api.devices.list,
        {},
        guard((list) => {
          const mine = this.deviceId
          this.server.devices = list.map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            platform: d.platform,
            appVersion: d.appVersion,
            lastSeenAt: d.lastSeenAt,
            createdAt: d.createdAt,
            current: d.deviceId === mine
          }))
        }),
        onError
      )
    )
  }

  /**
   * The managed-model status for today (UTC), asked once (not subscribed: a live `inference.status`
   * re-ran on every usage write). Asked again when the day changes, when the plan changes, after a
   * burst of dictations, and on `syncNow`. An instance that does not accept the `day` argument yet
   * answers with an argument error; then the status is asked the old way, without windows.
   */
  private refreshStatus(generation = this.generation): void {
    const client = this.client
    if (!client || !this.authenticated) return
    if (this.statusDayTimer) clearTimeout(this.statusDayTimer)
    this.statusDayTimer = null
    const args = this.statusWithoutDay ? {} : { day: currentUtcDay() }
    client
      .query(inferenceStatus, args)
      .then((status) => {
        if (generation !== this.generation) return
        this.server.inference = status
        this.lastSyncedAt = Date.now()
        this.emitStatus()
      })
      .catch((err: unknown) => {
        if (generation !== this.generation) return
        if (!this.statusWithoutDay && /ArgumentValidationError/i.test(errorMessage(err))) {
          log.info('instance does not take a day for inference.status; asking without it')
          this.statusWithoutDay = true
          this.refreshStatus(generation)
          return
        }
        this.error = errorMessage(err)
        log.warn(`inference status error: ${this.error}`)
        this.emitStatus()
      })
    if (!this.statusWithoutDay) {
      this.statusDayTimer = setTimeout(() => {
        this.statusDayTimer = null
        if (generation === this.generation && this.authenticated) this.refreshStatus(generation)
      }, msUntilNextUtcDay())
    }
  }

  /** Ask for the status again after `delayMs` of quiet (a burst of dictations asks once). */
  private scheduleStatusRefresh(delayMs: number): void {
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer)
    const generation = this.generation
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshTimer = null
      if (generation === this.generation) this.refreshStatus(generation)
    }, delayMs)
  }

  private stopStatusRefresh(): void {
    if (this.statusDayTimer) clearTimeout(this.statusDayTimer)
    this.statusDayTimer = null
    if (this.statusRefreshTimer) clearTimeout(this.statusRefreshTimer)
    this.statusRefreshTimer = null
  }

  /**
   * History sync on or off. On: fetch the newest page now and, from then on, only what is new
   * since the cursor whenever the account's stats move. Off: drop other devices' entries.
   */
  private updateHistorySubscription(generation = this.generation): void {
    const client = this.client
    const wanted = !!client && this.authenticated && this.deps.settings.get().cloud.historySync
    if (!wanted) {
      if (this.historyActive) {
        this.historyActive = false
        this.historyCursor = undefined
        this.deps.history.removeRemote()
      }
      return
    }
    if (this.historyActive) return
    this.historyActive = true
    this.historyCursor = undefined
    void this.fetchHistory(generation)
  }

  private scheduleHistoryFetch(delayMs: number): void {
    if (!this.historyActive) return
    if (this.historyTimer) clearTimeout(this.historyTimer)
    const generation = this.generation
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null
      if (generation === this.generation) void this.fetchHistory(generation)
    }, delayMs)
  }

  /** One-shot fetch of the entries other devices added since the cursor (pages of 20). */
  private async fetchHistory(generation: number): Promise<void> {
    const client = this.client
    if (!client || !this.historyActive) return
    if (this.historyFetching) {
      this.historyAgain = true
      return
    }
    this.historyFetching = true
    const mine = this.deviceId
    try {
      if (this.legacyHistory) {
        const list: RemoteHistoryEntry[] = await client.query(api.history.recent, {
          limit: HISTORY_PAGE
        })
        if (generation !== this.generation || !this.historyActive) return
        this.deps.history.appendRemote(
          list.filter((e) => e.deviceId !== mine).map(historyFromRemote)
        )
      } else {
        for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
          const res = await client.query(api.history.since, {
            cursor: this.historyCursor,
            limit: HISTORY_PAGE
          })
          if (generation !== this.generation || !this.historyActive) return
          this.historyCursor = res.cursor
          const theirs = res.entries.filter((e) => e.deviceId !== mine).map(historyFromRemote)
          if (theirs.length) this.deps.history.appendRemote(theirs)
          if (!res.more) break
        }
      }
      this.lastSyncedAt = Date.now()
      this.emitStatus()
    } catch (err) {
      if (generation !== this.generation) return
      if (!this.legacyHistory && isMissingFunction(err)) {
        log.info('instance has no history.since; fetching recent history the old way')
        this.legacyHistory = true
        this.historyAgain = true
      } else {
        this.error = errorMessage(err)
        this.emitStatus()
      }
    } finally {
      this.historyFetching = false
      if (this.historyAgain && generation === this.generation) {
        this.historyAgain = false
        void this.fetchHistory(generation)
      }
    }
  }

  private stopSubscriptions(): void {
    for (const unsub of this.subscriptions.splice(0)) unsub()
    this.stopStatusRefresh()
    if (this.historyTimer) clearTimeout(this.historyTimer)
    this.historyTimer = null
    this.historyActive = false
    this.historyCursor = undefined
  }

  // ---- derive server + outbox -> local mirror ----------------------------------------------

  private applyDerived(): void {
    const s = this.deps.settings.get()
    const ops = this.outbox.ops
    const patch: SettingsPatch = {
      dictionary: deriveCollection(dictionarySpec, this.server.dictionary, s.dictionary, ops),
      snippets: deriveCollection(snippetsSpec, this.server.snippets, s.snippets, ops),
      formatting: {
        appRules: deriveCollection(appRulesSpec, this.server.appRules, s.formatting.appRules, ops)
      },
      stats: deriveStats(s.stats, this.server.stats ?? null, ops)
    }
    let historyToggle: boolean | null = null
    if (this.server.preferences !== undefined) {
      const pending = ops
        .filter(
          (op): op is Extract<OutboxOp, { kind: 'preferences.update' }> =>
            op.kind === 'preferences.update'
        )
        .reduce<RemotePreferences>((acc, op) => mergePreferencePatches(acc, op.patch), {})
      const prefs = applyRemotePreferences(s, this.server.preferences, pending)
      patch.formatting = { ...patch.formatting, ...prefs.formatting }
      patch.stt = prefs.stt
      patch.cloud = prefs.cloud
      if (prefs.cloud.historySync !== s.cloud.historySync) historyToggle = prefs.cloud.historySync
    }
    this.applying = true
    try {
      const next = this.deps.settings.patch(patch, 'cloud')
      this.mirror = snapshot(next)
    } finally {
      this.applying = false
    }
    if (historyToggle !== null) {
      if (historyToggle) this.queueHistoryBacklog()
      this.updateHistorySubscription()
    }
  }

  private knownRemoteIds(): Set<string> {
    const ids = new Set<string>()
    for (const list of [this.server.dictionary, this.server.snippets, this.server.appRules]) {
      for (const item of list ?? []) ids.add(item.id)
    }
    for (const op of this.outbox.ops) if ('localId' in op && op.remoteId) ids.add(op.remoteId)
    return ids
  }

  private remoteIdFor(localId: string, remoteIds: Set<string>): string | undefined {
    if (remoteIds.has(localId)) return localId
    const op = this.outbox.ops.find((o) => 'localId' in o && o.localId === localId && o.remoteId)
    return op && 'remoteId' in op ? op.remoteId : undefined
  }

  // ---- local changes -> outbox -------------------------------------------------------------

  private readonly onSettingsChange = (next: Settings, _patch: unknown, origin?: string): void => {
    if (origin === 'cloud' || this.applying) return
    const prev = this.mirror
    this.mirror = snapshot(next)
    if (!this.auth.signedIn) return
    const remoteIds = this.knownRemoteIds()
    let touched = false

    const dict = diffCollection(prev.dictionary, next.dictionary, sameDictionaryEntry)
    for (const e of [...dict.added, ...dict.changed]) {
      touched = true
      this.outbox.update((ops) =>
        queueUpsert(ops, {
          id: randomUUID(),
          kind: 'dictionary.upsert',
          localId: e.id,
          remoteId: this.remoteIdFor(e.id, remoteIds),
          entry: dictionaryToInput(e)
        })
      )
    }
    for (const e of dict.removed) {
      touched = true
      this.outbox.update((ops) =>
        queueRemove(
          ops,
          'dictionary.upsert',
          'dictionary.remove',
          e.id,
          this.remoteIdFor(e.id, remoteIds),
          randomUUID()
        )
      )
    }

    const snips = diffCollection(prev.snippets, next.snippets, sameSnippet)
    for (const x of [...snips.added, ...snips.changed]) {
      touched = true
      this.outbox.update((ops) =>
        queueUpsert(ops, {
          id: randomUUID(),
          kind: 'snippets.upsert',
          localId: x.id,
          remoteId: this.remoteIdFor(x.id, remoteIds),
          snippet: snippetToInput(x)
        })
      )
    }
    for (const x of snips.removed) {
      touched = true
      this.outbox.update((ops) =>
        queueRemove(
          ops,
          'snippets.upsert',
          'snippets.remove',
          x.id,
          this.remoteIdFor(x.id, remoteIds),
          randomUUID()
        )
      )
    }

    const rules = diffCollection(prev.appRules, next.formatting.appRules, sameAppRule)
    for (const r of [...rules.added, ...rules.changed]) {
      if (!r.match.trim()) continue // the Style page adds an empty rule first, then fills it in
      touched = true
      this.outbox.update((ops) =>
        queueUpsert(ops, {
          id: randomUUID(),
          kind: 'appRules.upsert',
          localId: r.id,
          remoteId: this.remoteIdFor(r.id, remoteIds),
          rule: appRuleToInput(r, Date.now())
        })
      )
    }
    for (const r of rules.removed) {
      touched = true
      this.outbox.update((ops) =>
        queueRemove(
          ops,
          'appRules.upsert',
          'appRules.remove',
          r.id,
          this.remoteIdFor(r.id, remoteIds),
          randomUUID()
        )
      )
    }

    const nextPrefs = extractPreferences(next)
    if (!samePreferences(prev.prefs, nextPrefs)) {
      touched = true
      const patch = preferencesPatch(prev.prefs, nextPrefs)
      this.outbox.update((ops) => {
        const existing = ops.find(
          (op): op is Extract<OutboxOp, { kind: 'preferences.update' }> =>
            op.kind === 'preferences.update'
        )
        if (existing) {
          return ops.map((op) =>
            op.id === existing.id
              ? { ...existing, patch: mergePreferencePatches(existing.patch, patch) }
              : op
          )
        }
        return [...ops, { id: randomUUID(), kind: 'preferences.update', patch }]
      })
      if (prev.prefs.sync.history !== nextPrefs.sync.history) {
        if (nextPrefs.sync.history) this.queueHistoryBacklog()
        this.updateHistorySubscription()
      }
    }

    if (touched) {
      this.emitStatus()
      this.scheduleFlush(0)
    }
  }

  private readonly onHistoryAdded = (entry: HistoryEntry): void => {
    if (entry.remote || !this.auth.signedIn || !this.deps.settings.get().cloud.historySync) return
    const push = historyToPush(entry)
    if (!push) return
    this.outbox.update((ops) => queueHistoryPush(ops, push, randomUUID()))
    this.emitStatus()
    this.scheduleFlush(250)
  }

  private readonly onHistoryDeleted = (id: string, origin?: string): void => {
    if (origin === 'cloud' || !this.auth.signedIn || !this.deps.settings.get().cloud.historySync)
      return
    this.outbox.update((ops) => [...ops, { id: randomUUID(), kind: 'history.remove', entryId: id }])
    this.scheduleFlush(0)
  }

  private readonly onHistoryCleared = (origin?: string): void => {
    if (origin === 'cloud' || !this.auth.signedIn || !this.deps.settings.get().cloud.historySync)
      return
    this.outbox.update((ops) => [
      ...ops.filter((op) => op.kind !== 'history.push' && op.kind !== 'history.remove'),
      { id: randomUUID(), kind: 'history.clear' }
    ])
    this.scheduleFlush(0)
  }

  private queueHistoryBacklog(): void {
    const local = this.deps.history
      .list(HISTORY_BACKLOG, 0)
      .entries.filter((e) => !e.remote)
      .map(historyToPush)
      .filter((e): e is NonNullable<typeof e> => e !== null)
    if (!local.length) return
    this.outbox.update((ops) => {
      let next = ops
      for (const entry of local) next = queueHistoryPush(next, entry, randomUUID())
      return next
    })
  }

  /** Called by the dictation controller after each finished session. */
  recordSession(entry: HistoryEntry): void {
    if (!this.enabled || !this.auth.signedIn || entry.wordCount <= 0) return
    this.outbox.update((ops) => [
      ...ops,
      {
        id: randomUUID(),
        kind: 'stats.record',
        sessionId: entry.id,
        words: entry.wordCount,
        speechMs: entry.speechMs,
        day: localDay(new Date(entry.createdAt))
      }
    ])
    this.applyDerived()
    this.emitStatus()
    this.scheduleFlush(0)
  }

  /** Account-level onboarding finished on this device. */
  completeOnboarding(): void {
    if (!this.enabled || !this.auth.signedIn) return
    this.outbox.update((ops) => [
      ...ops.filter((op) => op.kind !== 'users.completeOnboarding'),
      { id: randomUUID(), kind: 'users.completeOnboarding', version: ONBOARDING_VERSION }
    ])
    if (this.server.user)
      this.server.user = { ...this.server.user, onboardingCompletedAt: Date.now() }
    this.emitStatus()
    this.scheduleFlush(0)
  }

  setHistorySync(enabled: boolean): void {
    this.deps.settings.patch({ cloud: { historySync: enabled } })
  }

  // ---- outbox flush ------------------------------------------------------------------------

  syncNow(): void {
    this.flushFailures = 0
    this.scheduleFlush(0)
    this.lastBootstrapAt = 0
    this.fetchBootstrap()
    this.refreshStatus()
    this.scheduleHistoryFetch(0)
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.client || !this.authenticated || this.disposed) return
    this.flushing = true
    const generation = this.generation
    let sent = false
    try {
      for (;;) {
        if (generation !== this.generation || !this.authenticated) break
        const op = this.outbox.ops.find((o) => !('acked' in o && o.acked))
        if (!op) break
        try {
          await this.send(op)
          sent = true
          if (generation !== this.generation) break
          this.attempts.delete(op.id)
          this.flushFailures = 0
          this.error = undefined
          // The server snapshot may already include this change; recompute without the op so a
          // pending increment is never counted twice.
          this.applyDerived()
        } catch (err) {
          if (generation !== this.generation) break
          if (isPermanentError(err)) {
            log.warn(`dropping ${op.kind}: ${errorMessage(err)}`)
            this.outbox.remove(op.id)
            this.applyDerived()
            continue
          }
          this.error = errorMessage(err)
          // Only failures while connected count toward dropping: offline is not the op's fault.
          if (this.connected) {
            const tries = (this.attempts.get(op.id) ?? 0) + 1
            this.attempts.set(op.id, tries)
            if (tries >= MAX_ATTEMPTS) {
              log.warn(`dropping ${op.kind} after ${tries} failed attempts: ${this.error}`)
              this.attempts.delete(op.id)
              this.outbox.remove(op.id)
              this.applyDerived()
              continue
            }
          }
          this.flushFailures++
          const delay = retryDelayMs(this.flushFailures)
          log.warn(
            `sync of ${op.kind} failed, retrying in ${Math.round(delay / 1000)}s: ${this.error}`
          )
          this.scheduleFlush(delay)
          break
        }
      }
      if (
        generation === this.generation &&
        !this.outbox.ops.some((o) => !('acked' in o && o.acked))
      ) {
        this.lastSyncedAt = Date.now()
        // Own mutations applied: ask for one fresh snapshot, which also prunes the ops the
        // server has folded in (the work the subscriptions used to do on every invalidation).
        if (sent) this.fetchBootstrap(generation)
      }
    } finally {
      this.flushing = false
      this.outbox.flush()
      this.emitStatus()
    }
  }

  private async send(op: OutboxOp): Promise<void> {
    const client = this.client
    if (!client) throw new Error('Cloud client not started')
    switch (op.kind) {
      case 'dictionary.upsert': {
        const id = await client.mutation(api.dictionary.upsert, {
          id: op.remoteId as Id<'dictionaryEntries'> | undefined,
          word: op.entry.word,
          aliases: op.entry.aliases,
          fuzzy: op.entry.fuzzy,
          createdAt: op.entry.createdAt
        })
        this.outbox.update((ops) => ackUpsert(ops, op.id, id))
        this.applyDerived()
        return
      }
      case 'dictionary.remove':
        await client.mutation(api.dictionary.remove, { id: op.remoteId as Id<'dictionaryEntries'> })
        break
      case 'snippets.upsert': {
        const id = await client.mutation(api.snippets.upsert, {
          id: op.remoteId as Id<'snippets'> | undefined,
          trigger: op.snippet.trigger,
          content: op.snippet.content,
          createdAt: op.snippet.createdAt
        })
        this.outbox.update((ops) => ackUpsert(ops, op.id, id))
        this.applyDerived()
        return
      }
      case 'snippets.remove':
        await client.mutation(api.snippets.remove, { id: op.remoteId as Id<'snippets'> })
        break
      case 'appRules.upsert': {
        const id = await client.mutation(api.appRules.upsert, {
          id: op.remoteId as Id<'appRules'> | undefined,
          match: op.rule.match,
          tone: op.rule.tone,
          formatting: op.rule.formatting,
          trailingSpace: op.rule.trailingSpace,
          instructions: op.rule.instructions,
          speed: op.rule.speed,
          createdAt: op.rule.createdAt
        })
        this.outbox.update((ops) => ackUpsert(ops, op.id, id))
        this.applyDerived()
        return
      }
      case 'appRules.remove':
        await client.mutation(api.appRules.remove, { id: op.remoteId as Id<'appRules'> })
        break
      case 'preferences.update':
        await client.mutation(api.preferences.update, {
          formatting: op.patch.formatting,
          language: op.patch.language,
          sync: op.patch.sync
        })
        break
      case 'stats.record': {
        // The run of stats ops at the head of the queue goes in one call (an offline backlog of
        // hundreds of dictations drains in a handful of mutations instead of one per dictation).
        const run: Array<Extract<OutboxOp, { kind: 'stats.record' }>> = []
        for (const o of this.outbox.ops) {
          if ('acked' in o && o.acked) continue
          if (o.kind !== 'stats.record' || run.length >= STATS_BATCH) break
          run.push(o)
        }
        if (!this.legacyStats && run.length > 1) {
          try {
            await client.mutation(api.stats.recordMany, {
              sessions: run.map((o) => ({
                words: o.words,
                speechMs: o.speechMs,
                day: o.day,
                sessionId: o.sessionId
              }))
            })
            const sent = new Set(run.map((o) => o.id))
            this.outbox.update((ops) => ops.filter((o) => !sent.has(o.id)))
            return
          } catch (err) {
            if (!isMissingFunction(err)) throw err
            log.info('instance has no stats.recordMany; recording sessions one by one')
            this.legacyStats = true
          }
        }
        await client.mutation(api.stats.recordSession, {
          words: op.words,
          speechMs: op.speechMs,
          day: op.day,
          sessionId: op.sessionId
        })
        break
      }
      case 'history.push':
        await client.mutation(api.history.push, { deviceId: this.deviceId, entries: op.entries })
        break
      case 'history.remove':
        await client.mutation(api.history.remove, { entryId: op.entryId })
        break
      case 'history.clear':
        await client.mutation(api.history.clear, {})
        break
      case 'users.completeOnboarding':
        await client.mutation(api.users.completeOnboarding, { version: op.version })
        break
    }
    this.outbox.remove(op.id)
  }

  // ---- devices -----------------------------------------------------------------------------

  private ensureDeviceIdentity(): void {
    const s = this.deps.settings.get()
    const patch: SettingsPatch['cloud'] = {}
    if (!s.cloud.deviceId) patch.deviceId = randomUUID()
    if (!s.cloud.deviceName) patch.deviceName = hostname() || 'This computer'
    if (Object.keys(patch).length) this.deps.settings.patch({ cloud: patch }, 'cloud')
  }

  private async heartbeat(): Promise<void> {
    const client = this.client
    if (!client || !this.authenticated) return
    const s = this.deps.settings.get()
    const platform: Platform =
      this.deps.platform === 'win32' || this.deps.platform === 'darwin'
        ? this.deps.platform
        : 'linux'
    await client.mutation(api.devices.heartbeat, {
      deviceId: s.cloud.deviceId,
      name: s.cloud.deviceName || hostname() || 'This computer',
      platform,
      appVersion: this.deps.appVersion
    })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => log.debug(`heartbeat failed: ${errorMessage(err)}`))
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  async removeDevice(deviceId: string): Promise<boolean> {
    if (!this.client || !this.authenticated) throw new Error('Not connected to your account')
    return await this.client.mutation(api.devices.remove, { deviceId })
  }

  /** Erase the account's data in the cloud; subscriptions then empty the local mirror. */
  async deleteMyData(): Promise<void> {
    if (!this.client || !this.authenticated) throw new Error('Not connected to your account')
    this.outbox.update(() => [])
    await this.client.mutation(api.users.deleteMyData, {})
    this.deps.history.replaceAll([], 'cloud')
  }

  // ---- status ------------------------------------------------------------------------------

  getStatus(): SyncStatus {
    const pendingOps = this.outbox.ops.filter((o) => !('acked' in o && o.acked)).length
    let phase: SyncPhase
    if (!this.enabled) phase = 'disabled'
    else if (!this.auth.signedIn) phase = 'signed-out'
    else if (this.error && !pendingOps && this.connected) phase = 'error'
    else if (!this.connected) phase = 'offline'
    else if (!this.authenticated) phase = 'connecting'
    else if (this.error) phase = 'error'
    else if (pendingOps > 0) phase = 'syncing'
    else phase = 'synced'
    return {
      configured: this.enabled,
      phase,
      signedIn: this.auth.signedIn,
      authenticated: this.authenticated,
      connected: this.connected,
      pendingOps,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error,
      user: this.server.user ?? null,
      devices: this.server.devices ?? [],
      deviceId: this.deviceId,
      inference: this.server.inference
    }
  }

  private emitStatus(): void {
    if (this.disposed) return
    this.emit('status', this.getStatus())
  }

  dispose(): void {
    this.disposed = true
    this.stopSubscriptions()
    this.stopHeartbeat()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.connectionUnsub?.()
    this.deps.settings.off('change', this.onSettingsChange)
    this.deps.history.off('added', this.onHistoryAdded)
    this.deps.history.off('replaced', this.onHistoryAdded)
    this.deps.history.off('deleted', this.onHistoryDeleted)
    this.deps.history.off('cleared', this.onHistoryCleared)
    this.outbox.flush()
    void this.client?.close()
    this.client = null
  }
}
