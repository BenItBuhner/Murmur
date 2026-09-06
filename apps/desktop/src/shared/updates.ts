/**
 * Update system types shared by the main process, the preload bridge and the renderer.
 *
 * Updates come straight from the GitHub Releases of the repository this build was made from: the
 * app lists the releases, picks the newest one that is newer than itself, downloads the asset the
 * release workflow published for this exact install flavour, verifies it against the release's
 * SHA256SUMS.txt and then either applies it itself or hands the file to the user.
 */

/**
 * How this copy of Murmur was installed. Decides which release asset is the right one and whether
 * the app can apply an update by itself.
 *
 * - `nsis`: Windows installer (per-user). Updates run the new installer silently and relaunch.
 * - `portable`: Windows portable exe. The running file cannot replace itself; the new build is
 *   downloaded next to it for the user to swap.
 * - `appimage`: Linux AppImage. The file is replaced in place and relaunched.
 * - `deb`: Installed from the .deb. The new package is installed through `pkexec dpkg -i`.
 * - `mac`: macOS app bundle. The bundle is swapped from the release .zip and relaunched.
 * - `dev`: Unpackaged development build (`npm run dev`). Checks work, installing does not apply.
 * - `unknown`: Packaged but not in a recognised layout; the download is handed to the user.
 */
export type InstallKind = 'nsis' | 'portable' | 'appimage' | 'deb' | 'mac' | 'dev' | 'unknown'

/** Install kinds the updater can apply by itself and relaunch. */
export function kindCanSelfUpdate(kind: InstallKind): boolean {
  return kind === 'nsis' || kind === 'appimage' || kind === 'deb' || kind === 'mac'
}

/** Short human label for the About/Updates UI. */
export function describeInstallKind(kind: InstallKind): string {
  switch (kind) {
    case 'nsis':
      return 'Windows installer'
    case 'portable':
      return 'Windows portable'
    case 'appimage':
      return 'AppImage'
    case 'deb':
      return 'Debian package'
    case 'mac':
      return 'macOS app'
    case 'dev':
      return 'development build'
    default:
      return 'unpackaged'
  }
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateAsset {
  name: string
  url: string
  size: number
}

export interface UpdateRelease {
  /** Semver without the leading `v`. */
  version: string
  tag: string
  name: string
  /** Release page on GitHub. */
  url: string
  publishedAt: number | null
  prerelease: boolean
  /** Release body (markdown) as published by the release workflow. */
  notes: string
  /** The file for this install flavour, or null when the release does not ship one. */
  asset: UpdateAsset | null
  /** SHA-256 of `asset` from the release's SHA256SUMS.txt, when the release ships one. */
  sha256: string | null
}

export interface UpdateProgress {
  /** 0..100 */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  installKind: InstallKind
  /** True when this install can apply a downloaded update by itself and relaunch. */
  canInstall: boolean
  /** Unix ms of the last completed check (successful or not), or null if never checked. */
  lastCheckedAt: number | null
  /** The newest eligible release found by the last check, if it is newer than the running version. */
  release: UpdateRelease | null
  progress: UpdateProgress | null
  /** Verified local copy of `release.asset`, when downloaded. */
  downloadedPath: string | null
  error: string | null
  /** Automatic installation is armed and waiting for the current dictation to finish. */
  waitingForIdle: boolean
  /** Set once after the app relaunches into a version it installed itself; the renderer toasts it. */
  updatedFrom: string | null
}
