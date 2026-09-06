import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { UpdateStatus } from '@shared/updates'
import idleIcon from '../../resources/tray/idle.png?asset'
import idleIcon2x from '../../resources/tray/idle@2x.png?asset'
import listeningIcon from '../../resources/tray/listening.png?asset'
import listeningIcon2x from '../../resources/tray/listening@2x.png?asset'
import processingIcon from '../../resources/tray/processing.png?asset'
import processingIcon2x from '../../resources/tray/processing@2x.png?asset'
import disabledIcon from '../../resources/tray/disabled.png?asset'
import disabledIcon2x from '../../resources/tray/disabled@2x.png?asset'

export type TrayPhase = 'idle' | 'listening' | 'processing' | 'disabled'

export interface TrayActions {
  toggleDictation: () => void
  setEnabled: (enabled: boolean) => void
  openApp: (route?: string) => void
  openLogs: () => void
  checkForUpdates: () => void
  installUpdate: () => void
  quit: () => void
}

function image(path1x: string, path2x: string): Electron.NativeImage {
  const img = nativeImage.createFromPath(path1x)
  try {
    img.addRepresentation({
      scaleFactor: 2,
      dataURL: nativeImage.createFromPath(path2x).toDataURL()
    })
  } catch {
    // ignore
  }
  return img
}

export class AppTray {
  private tray: Tray
  private phase: TrayPhase = 'idle'
  private enabled = true
  private hotkeyLabel = ''
  private update: UpdateStatus | null = null
  private icons: Record<TrayPhase, Electron.NativeImage>

  constructor(private actions: TrayActions) {
    this.icons = {
      idle: image(idleIcon, idleIcon2x),
      listening: image(listeningIcon, listeningIcon2x),
      processing: image(processingIcon, processingIcon2x),
      disabled: image(disabledIcon, disabledIcon2x)
    }
    this.tray = new Tray(this.icons.idle)
    this.tray.setToolTip('Murmur')
    this.tray.on('click', () => {
      if (process.platform === 'win32') this.actions.openApp()
      else this.tray.popUpContextMenu()
    })
    this.tray.on('double-click', () => this.actions.openApp())
    this.rebuild()
  }

  setPhase(phase: TrayPhase): void {
    this.phase = phase
    this.tray.setImage(this.icons[this.enabled ? phase : 'disabled'])
    this.rebuild()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.setPhase(this.phase)
  }

  setHotkeyLabel(label: string): void {
    this.hotkeyLabel = label
    this.rebuild()
  }

  setUpdate(status: UpdateStatus): void {
    // Progress ticks arrive several times a second; only rebuild the menu when the item changes.
    const before = this.updateItem()
    this.update = status
    if (before.label !== this.updateItem().label) this.rebuild()
  }

  /** The update entry: install when ready, otherwise point at the release, otherwise check. */
  private updateItem(): MenuItemConstructorOptions {
    const u = this.update
    if (u?.phase === 'ready' && u.release) {
      return u.canInstall
        ? {
            label: `Install Murmur ${u.release.version} and restart`,
            click: () => this.actions.installUpdate()
          }
        : {
            label: `Murmur ${u.release.version} downloaded…`,
            click: () => this.actions.openApp('general')
          }
    }
    if ((u?.phase === 'available' || u?.phase === 'downloading') && u.release) {
      return {
        label:
          u.phase === 'downloading'
            ? `Downloading Murmur ${u.release.version}…`
            : `Murmur ${u.release.version} is available…`,
        click: () => this.actions.openApp('general')
      }
    }
    return {
      label: u?.phase === 'checking' ? 'Checking for updates…' : 'Check for updates…',
      enabled: u?.phase !== 'checking' && u?.phase !== 'installing',
      click: () => this.actions.checkForUpdates()
    }
  }

  private rebuild(): void {
    const listening = this.phase === 'listening'
    const status = !this.enabled
      ? 'Paused'
      : listening
        ? 'Listening…'
        : this.phase === 'processing'
          ? 'Transcribing…'
          : 'Ready'
    const template: MenuItemConstructorOptions[] = [
      { label: `Murmur — ${status}`, enabled: false },
      {
        label: this.hotkeyLabel ? `Hold ${this.hotkeyLabel} to dictate` : 'No shortcut set',
        enabled: false
      },
      { type: 'separator' },
      {
        label: listening ? 'Stop and insert' : 'Start hands-free dictation',
        click: () => this.actions.toggleDictation(),
        enabled: this.enabled
      },
      {
        label: 'Enabled',
        type: 'checkbox',
        checked: this.enabled,
        click: (item) => this.actions.setEnabled(item.checked)
      },
      { type: 'separator' },
      { label: 'Open Murmur', click: () => this.actions.openApp() },
      { label: 'History', click: () => this.actions.openApp('history') },
      { label: 'Settings', click: () => this.actions.openApp('general') },
      { label: 'Open log file', click: () => this.actions.openLogs() },
      { type: 'separator' },
      this.updateItem(),
      { type: 'separator' },
      { label: 'Quit Murmur', click: () => this.actions.quit() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
    this.tray.setToolTip(`Murmur — ${status}`)
  }

  destroy(): void {
    this.tray.destroy()
  }
}
