import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createLogger } from './logger'

const log = createLogger('autostart')

/** Electron only implements login items on Windows/macOS; on Linux we write an XDG autostart entry. */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    if (process.platform === 'linux') {
      const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart')
      const file = join(dir, 'murmur.desktop')
      if (!enabled) {
        if (existsSync(file)) unlinkSync(file)
        return
      }
      mkdirSync(dir, { recursive: true })
      const exec = process.env.APPIMAGE ?? process.execPath
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Murmur',
          'Comment=Voice dictation',
          `Exec="${exec}" --hidden`,
          'Icon=murmur',
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true'
        ].join('\n')
      )
      return
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
  } catch (err) {
    log.warn('applyLaunchAtLogin failed', err)
  }
}
