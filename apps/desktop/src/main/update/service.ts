import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import type { InstallKind, UpdateStatus } from '@shared/updates'
import {
  assetCandidates,
  CHECKSUMS_ASSET,
  describeRelease,
  isTrustedAssetUrl,
  parseChecksums,
  pickAsset,
  selectRelease,
  toUpdateArch,
  type GithubRelease
} from '@core/update/releases'
import type { Logger } from '../logger'
import { JsonStore } from '../store/json-store'
import type { SettingsStore } from '../store/settings'
import { ChecksumMismatchError, downloadFile, type FetchLike } from './download'
import { kindCanSelfUpdate } from './install-kind'
import { releasesUrl, type UpdateSource } from './source'

/** Persisted between runs (userData/updater.json). */
interface UpdaterState {
  lastCheckedAt: number | null
  /** Written right before an installer runs; the next start uses it to confirm the update. */
  pending: { version: string; from: string; showWindow: boolean } | null
}

function parseState(raw: unknown): UpdaterState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pending = obj.pending as Record<string, unknown> | null | undefined
  return {
    lastCheckedAt: typeof obj.lastCheckedAt === 'number' ? obj.lastCheckedAt : null,
    pending:
      pending && typeof pending.version === 'string' && typeof pending.from === 'string'
        ? { version: pending.version, from: pending.from, showWindow: !!pending.showWindow }
        : null
  }
}

export interface UpdateServiceDeps {
  settings: SettingsStore
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  installKind: InstallKind
  source: UpdateSource
  /** Downloads and installer scratch files; wiped on every start. */
  downloadDir: string
  stateFile: string
  fetch: FetchLike
  /** Applies a verified file for this install kind and arranges the relaunch. */
  apply: (kind: InstallKind, file: string) => Promise<void>
  /** No dictation in flight, so a restart will not interrupt anything. */
  isIdle: () => boolean
  isMainWindowVisible: () => boolean
  /** Flush persisted state; the Windows installer kills this process as soon as it starts. */
  beforeInstall: () => void
  quit: () => void
  log: Logger
  checkIntervalMs?: number
  initialDelayMs?: number
  /** Grace period between a finished download and an automatic restart. */
  autoInstallDelayMs?: number
}

export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
export const DEFAULT_INITIAL_DELAY_MS = 20_000
export const DEFAULT_AUTO_INSTALL_DELAY_MS = 4_000

/**
 * Keeps this install current from the repository's GitHub Releases.
 *
 *   idle -> checking -> up-to-date | available -> downloading -> ready -> installing -> (relaunch)
 *
 * Checks run shortly after start and every few hours when `updates.autoCheck` is on, and whenever
 * the user asks. With `updates.autoInstall` the asset is downloaded in the background and, once
 * verified against the release's SHA256SUMS.txt, installed as soon as no dictation is running.
 * Installs that cannot replace themselves stop at `ready` and hand the file to the user.
 */
export class UpdateService extends EventEmitter {
  private status: UpdateStatus
  private readonly state: JsonStore<UpdaterState>
  private readonly restoreWindow: boolean
  /** This process was started by an update; confirm "up to date" soon instead of waiting a cycle. */
  private readonly justUpdated: boolean
  /** Whether the asset selected for the current release can be applied on this install kind. */
  private installable = false
  private checkTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private autoTimer: NodeJS.Timeout | null = null
  private abort: AbortController | null = null
  private inflight: Promise<UpdateStatus> | null = null
  private lastPrefs: Settings['updates']

  constructor(private readonly deps: UpdateServiceDeps) {
    super()
    this.state = new JsonStore<UpdaterState>(deps.stateFile, parseState, 0)
    const persisted = this.state.get()
    let updatedFrom: string | null = null
    let restoreWindow = false
    if (persisted.pending) {
      if (persisted.pending.version === deps.currentVersion) {
        updatedFrom = persisted.pending.from
        restoreWindow = persisted.pending.showWindow
        deps.log.info(`relaunched after updating from ${updatedFrom} to ${deps.currentVersion}`)
      } else {
        deps.log.warn(`update to ${persisted.pending.version} did not complete`)
      }
      this.state.set({ ...persisted, pending: null })
      this.state.flush()
    }
    this.restoreWindow = restoreWindow
    this.justUpdated = updatedFrom !== null
    this.cleanDownloadDir()
    this.lastPrefs = deps.settings.get().updates
    this.status = {
      phase: 'idle',
      currentVersion: deps.currentVersion,
      installKind: deps.installKind,
      canInstall: kindCanSelfUpdate(deps.installKind),
      lastCheckedAt: persisted.lastCheckedAt,
      release: null,
      progress: null,
      downloadedPath: null,
      error: null,
      waitingForIdle: false,
      updatedFrom
    }
  }

  /** The app was just relaunched by an update and its window was open before; show it again. */
  get shouldShowWindowAfterUpdate(): boolean {
    return this.restoreWindow
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  start(): void {
    this.deps.settings.on('change', this.onSettingsChange)
    this.schedule()
  }

  dispose(): void {
    this.deps.settings.off('change', this.onSettingsChange)
    this.clearTimers()
    this.abort?.abort()
    this.state.flush()
  }

  /** The dictation controller reports every return to idle so a deferred install can proceed. */
  notifyIdle(): void {
    if (this.status.waitingForIdle && !this.autoTimer) this.armAutoInstall()
  }

  /** The renderer has shown the "updated to" notice. */
  ackUpdated(): void {
    if (this.status.updatedFrom) this.set({ updatedFrom: null })
  }

  // ---- checking -------------------------------------------------------------------------------

  check(opts: { manual: boolean }): Promise<UpdateStatus> {
    if (this.inflight) return this.inflight
    // A download or install owns the state until it finishes; the next cycle will re-check.
    if (this.status.phase === 'installing' || this.status.phase === 'downloading') {
      return Promise.resolve(this.status)
    }
    this.inflight = this.doCheck(opts).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doCheck(opts: { manual: boolean }): Promise<UpdateStatus> {
    const prev = this.status
    const prefs = this.deps.settings.get().updates
    this.set({ phase: 'checking', error: null })
    try {
      const releases = await this.fetchReleases()
      const chosen = selectRelease(releases, {
        currentVersion: this.deps.currentVersion,
        includePrereleases: prefs.includePrereleases,
        skippedVersion: opts.manual ? undefined : prefs.skippedVersion
      })
      const checkedAt = Date.now()
      this.state.set({ ...this.state.get(), lastCheckedAt: checkedAt })
      this.state.flush()

      if (!chosen) {
        this.clearAutoTimer()
        this.discardDownload()
        this.installable = false
        this.set({
          phase: 'up-to-date',
          release: null,
          downloadedPath: null,
          progress: null,
          waitingForIdle: false,
          lastCheckedAt: checkedAt
        })
        return this.status
      }

      const candidates = assetCandidates(
        this.deps.installKind,
        this.deps.platform,
        toUpdateArch(this.deps.arch),
        chosen.tag_name
      )
      const picked = pickAsset(chosen, candidates)
      let asset = picked?.asset ?? null
      if (
        asset &&
        !isTrustedAssetUrl(asset.browser_download_url, this.deps.source.downloadOrigin)
      ) {
        this.deps.log.warn(
          `ignoring asset served from an unexpected origin: ${asset.browser_download_url}`
        )
        asset = null
      }
      const sha256 = asset ? await this.fetchChecksum(chosen, asset.name) : null
      const release = describeRelease(chosen, asset, sha256)
      this.installable = !!asset && !!picked?.installable
      this.deps.log.info(
        `update available: ${release.version} (${asset?.name ?? 'no file for this platform'}${sha256 ? ', checksum found' : ', no checksum'})`
      )

      const sameDownload =
        prev.phase === 'ready' &&
        !!prev.downloadedPath &&
        existsSync(prev.downloadedPath) &&
        prev.release?.version === release.version &&
        prev.release?.asset?.name === release.asset?.name
      if (sameDownload) {
        this.set({ phase: 'ready', release, lastCheckedAt: checkedAt })
        return this.status
      }

      this.clearAutoTimer()
      this.discardDownload()
      this.set({
        phase: 'available',
        release,
        downloadedPath: null,
        progress: null,
        waitingForIdle: false,
        lastCheckedAt: checkedAt
      })
      if (prefs.autoInstall && release.asset) void this.download()
      return this.status
    } catch (err) {
      const message = friendlyUpdateError(err)
      this.deps.log.warn(`update check failed: ${message}`)
      // A failed re-check must not throw away a verified download.
      const keepReady = prev.phase === 'ready' && !!prev.downloadedPath
      this.set({
        phase: keepReady ? 'ready' : 'error',
        error: message,
        lastCheckedAt: Date.now()
      })
      return this.status
    }
  }

  private async fetchReleases(): Promise<GithubRelease[]> {
    const res = await this.deps.fetch(releasesUrl(this.deps.source), {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Murmur/${this.deps.currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 403 || res.status === 429) {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
        const when = reset ? ` Try again after ${new Date(reset).toLocaleTimeString()}.` : ''
        throw new Error(`GitHub API rate limit reached.${when}`)
      }
    }
    if (res.status === 404) {
      throw new Error(
        `No releases found for ${this.deps.source.repo}. Is the repository public and released?`
      )
    }
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`)
    const json = (await res.json()) as unknown
    if (!Array.isArray(json)) throw new Error('Unexpected response from GitHub')
    return json.filter(
      (r): r is GithubRelease =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as GithubRelease).tag_name === 'string' &&
        Array.isArray((r as GithubRelease).assets)
    )
  }

  /** SHA-256 for `assetName` from the release's SHA256SUMS.txt, or null when unavailable. */
  private async fetchChecksum(release: GithubRelease, assetName: string): Promise<string | null> {
    const sums = release.assets.find((a) => a.name === CHECKSUMS_ASSET)
    if (!sums) {
      this.deps.log.warn(`${release.tag_name} ships no ${CHECKSUMS_ASSET}; installing is disabled`)
      return null
    }
    if (!isTrustedAssetUrl(sums.browser_download_url, this.deps.source.downloadOrigin)) return null
    try {
      const res = await this.deps.fetch(sums.browser_download_url, {
        headers: { 'User-Agent': `Murmur/${this.deps.currentVersion}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const digest = parseChecksums(await res.text()).get(assetName)
      if (!digest) this.deps.log.warn(`${CHECKSUMS_ASSET} has no entry for ${assetName}`)
      return digest ?? null
    } catch (err) {
      this.deps.log.warn(`could not fetch ${CHECKSUMS_ASSET}`, err)
      return null
    }
  }

  // ---- downloading ----------------------------------------------------------------------------

  async download(): Promise<UpdateStatus> {
    const { release, phase } = this.status
    if (!release?.asset) return this.status
    if (phase === 'downloading' || phase === 'installing' || phase === 'checking')
      return this.status
    if (phase === 'ready' && this.status.downloadedPath && existsSync(this.status.downloadedPath)) {
      return this.status
    }
    const asset = release.asset
    const dest = join(this.deps.downloadDir, asset.name)
    this.abort = new AbortController()
    this.set({
      phase: 'downloading',
      error: null,
      downloadedPath: null,
      progress: { percent: 0, transferred: 0, total: asset.size, bytesPerSecond: 0 }
    })
    this.deps.log.info(`downloading ${asset.url} (${asset.size} bytes)`)
    try {
      await downloadFile(asset.url, {
        fetch: this.deps.fetch,
        dest,
        expectedSize: asset.size,
        expectedSha256: release.sha256,
        signal: this.abort.signal,
        onProgress: (progress) => this.set({ progress })
      })
      this.deps.log.info(
        `downloaded and ${release.sha256 ? 'verified' : 'saved (unverified)'}: ${dest}`
      )
      this.set({ phase: 'ready', downloadedPath: dest, progress: null })
      if (this.deps.settings.get().updates.autoInstall && this.canInstallRelease()) {
        this.armAutoInstall()
      }
    } catch (err) {
      if (this.abort?.signal.aborted) {
        this.set({ phase: 'available', progress: null, downloadedPath: null })
      } else {
        const message =
          err instanceof ChecksumMismatchError
            ? 'The downloaded file did not match the release checksum, so it was discarded.'
            : friendlyUpdateError(err)
        this.deps.log.warn(`download failed: ${message}`)
        this.set({ phase: 'error', error: message, progress: null, downloadedPath: null })
      }
    } finally {
      this.abort = null
    }
    return this.status
  }

  cancelDownload(): void {
    this.abort?.abort()
  }

  // ---- installing -----------------------------------------------------------------------------

  private canInstallRelease(): boolean {
    return (
      kindCanSelfUpdate(this.deps.installKind) && this.installable && !!this.status.release?.sha256
    )
  }

  private armAutoInstall(): void {
    if (this.status.phase !== 'ready' || !this.canInstallRelease()) return
    this.clearAutoTimer()
    this.set({ waitingForIdle: true })
    if (!this.deps.isIdle()) return
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null
      if (this.status.phase !== 'ready' || !this.deps.settings.get().updates.autoInstall) {
        this.set({ waitingForIdle: false })
        return
      }
      // A dictation may have started during the grace period; notifyIdle() re-arms us.
      if (this.deps.isIdle()) void this.install()
    }, this.deps.autoInstallDelayMs ?? DEFAULT_AUTO_INSTALL_DELAY_MS)
  }

  async install(): Promise<UpdateStatus> {
    const { release, downloadedPath, phase } = this.status
    if (phase !== 'ready' || !release || !downloadedPath) return this.status
    if (!this.canInstallRelease()) {
      this.set({
        error: 'This copy of Murmur cannot update itself. Open the download to install it.'
      })
      return this.status
    }
    if (!existsSync(downloadedPath)) {
      this.set({
        phase: 'available',
        downloadedPath: null,
        error: 'The downloaded file is gone. Download it again.'
      })
      return this.status
    }
    this.clearAutoTimer()
    this.set({ phase: 'installing', waitingForIdle: false, error: null })
    this.state.set({
      ...this.state.get(),
      pending: {
        version: release.version,
        from: this.deps.currentVersion,
        showWindow: this.deps.isMainWindowVisible()
      }
    })
    this.state.flush()
    try {
      this.deps.beforeInstall()
      await this.deps.apply(this.deps.installKind, downloadedPath)
      this.deps.log.info(`update ${release.version} applied; quitting so it can start`)
      this.deps.quit()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log.error(`install failed: ${message}`)
      this.state.set({ ...this.state.get(), pending: null })
      this.state.flush()
      this.set({ phase: 'ready', error: message })
    }
    return this.status
  }

  /** Dismiss the offered version until a newer one shows up (a manual check still lists it). */
  skip(): UpdateStatus {
    const release = this.status.release
    if (!release) return this.status
    this.clearAutoTimer()
    this.abort?.abort()
    this.deps.settings.patch({ updates: { skippedVersion: release.version } })
    this.discardDownload()
    this.installable = false
    this.set({
      phase: 'up-to-date',
      release: null,
      downloadedPath: null,
      progress: null,
      waitingForIdle: false,
      error: null
    })
    this.deps.log.info(`skipped ${release.version}`)
    return this.status
  }

  // ---- scheduling -----------------------------------------------------------------------------

  private readonly onSettingsChange = (next: Settings): void => {
    const prev = this.lastPrefs
    const prefs = next.updates
    this.lastPrefs = prefs
    if (prefs.autoCheck !== prev.autoCheck) this.schedule()
    if (prefs.includePrereleases !== prev.includePrereleases && prefs.autoCheck) {
      void this.check({ manual: false })
    }
    if (prefs.autoInstall !== prev.autoInstall) {
      if (prefs.autoInstall) {
        if (this.status.phase === 'available' && this.status.release?.asset) void this.download()
        else this.armAutoInstall()
      } else {
        this.clearAutoTimer()
        this.set({ waitingForIdle: false })
      }
    }
  }

  private schedule(): void {
    this.clearScheduleTimers()
    if (!this.deps.settings.get().updates.autoCheck) return
    const interval = this.deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    const initial = this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
    const last = this.status.lastCheckedAt
    // Soon after start, unless a check happened recently (a quick restart); an update relaunch
    // always re-checks so the UI can confirm the new version is current.
    const first =
      last && !this.justUpdated ? Math.max(initial, last + interval - Date.now()) : initial
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null
      void this.check({ manual: false })
      this.intervalTimer = setInterval(() => void this.check({ manual: false }), interval)
    }, first)
  }

  private clearScheduleTimers(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.checkTimer = null
    this.intervalTimer = null
  }

  private clearAutoTimer(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = null
  }

  private clearTimers(): void {
    this.clearScheduleTimers()
    this.clearAutoTimer()
  }

  // ---- files ----------------------------------------------------------------------------------

  private discardDownload(): void {
    const path = this.status.downloadedPath
    if (path) rmSync(path, { force: true })
  }

  private cleanDownloadDir(): void {
    try {
      mkdirSync(this.deps.downloadDir, { recursive: true })
      for (const entry of readdirSync(this.deps.downloadDir)) {
        rmSync(join(this.deps.downloadDir, entry), { recursive: true, force: true })
      }
    } catch (err) {
      this.deps.log.warn('could not clean the updates directory', err)
    }
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.status.canInstall = this.status.release
      ? this.canInstallRelease()
      : kindCanSelfUpdate(this.deps.installKind)
    this.emit('status', this.status)
  }
}

export function friendlyUpdateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (
    /fetch failed|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_NETWORK/i.test(
      message
    )
  ) {
    return 'Could not reach GitHub. Check your connection and try again.'
  }
  return message
}
