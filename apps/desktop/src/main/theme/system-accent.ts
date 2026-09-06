import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeTheme, systemPreferences } from 'electron'
import { parseElectronAccent, parseGnomeAccent, parseKdeAccent } from '@shared/theme'
import { createLogger } from '../logger'

const log = createLogger('accent')

/** How often to re-read the desktop's accent on Linux, where nothing pushes a change notification. */
const LINUX_POLL_MS = 20_000

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : stdout))
    } catch {
      resolve(null)
    }
  })
}

/**
 * The accent colour the operating system exposes, as `#rrggbb`, or `null` when the platform has
 * none to offer. Windows and macOS publish it through Electron; on Linux we ask GNOME (47+) and
 * KDE the way their own apps do, so "System" works across the three desktops Murmur ships to.
 */
export async function readSystemAccent(): Promise<string | null> {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      return parseElectronAccent(systemPreferences.getAccentColor())
    } catch (err) {
      log.warn('getAccentColor failed', err)
      return null
    }
  }
  if (process.platform !== 'linux') return null
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase()
  const preferKde = desktop.includes('kde') || desktop.includes('plasma')
  const readers: Array<() => Promise<string | null>> = [
    async () =>
      parseGnomeAccent(
        await run('gsettings', ['get', 'org.gnome.desktop.interface', 'accent-color'])
      ),
    async () => {
      const home = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
      try {
        return parseKdeAccent(await readFile(join(home, 'kdeglobals'), 'utf8'))
      } catch {
        return null
      }
    }
  ]
  if (preferKde) readers.reverse()
  for (const read of readers) {
    const hex = await read()
    if (hex) return hex
  }
  return null
}

/** Caches the OS accent and emits `change` with the new `#rrggbb` (or null) when it moves. */
export class SystemAccent extends EventEmitter {
  private current: string | null = null
  private timer: NodeJS.Timeout | null = null
  private onNativeTheme = (): void => void this.refresh()
  private onWinAccent = (): void => void this.refresh()

  get(): string | null {
    return this.current
  }

  async start(): Promise<string | null> {
    await this.refresh(true)
    if (process.platform === 'win32') {
      systemPreferences.on('accent-color-changed', this.onWinAccent)
    } else if (process.platform === 'darwin') {
      // macOS re-reads the accent when the appearance changes; the accent picker also fires this.
      nativeTheme.on('updated', this.onNativeTheme)
    } else if (process.platform === 'linux') {
      nativeTheme.on('updated', this.onNativeTheme)
      this.timer = setInterval(() => void this.refresh(), LINUX_POLL_MS)
      this.timer.unref()
    }
    return this.current
  }

  async refresh(quiet = false): Promise<void> {
    const next = await readSystemAccent()
    if (next === this.current) return
    this.current = next
    if (!quiet) log.info(`system accent changed: ${next ?? 'none'}`)
    this.emit('change', next)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (process.platform === 'win32') {
      systemPreferences.removeListener('accent-color-changed', this.onWinAccent)
    } else {
      nativeTheme.removeListener('updated', this.onNativeTheme)
    }
  }
}
