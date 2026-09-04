import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { OverlayPosition } from '@shared/settings'
import type { OverlayState } from '@shared/types'
import { IPC, type SoundName } from '@shared/ipc'
import { createLogger } from '../logger'

const log = createLogger('overlay')

const WIDTH = 360
const HEIGHT = 120
const MARGIN = 28

/**
 * The always-alive overlay window. It renders the pill *and* owns microphone capture (a renderer
 * is the only place Electron exposes getUserMedia), so it is created once at startup and never
 * destroyed; visibility is toggled instead.
 */
export class OverlayWindow {
  private win: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private state: OverlayState = { phase: 'idle' }
  private showWhenIdle = true
  private position: OverlayPosition = 'bottom-center'
  private ready: Promise<void>
  private resolveReady!: () => void

  constructor() {
    this.ready = new Promise((r) => (this.resolveReady = r))
  }

  create(): BrowserWindow {
    if (this.win) return this.win
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      type:
        process.platform === 'win32'
          ? 'toolbar'
          : process.platform === 'linux'
            ? 'notification'
            : undefined,
      title: 'Murmur overlay',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        sandbox: false,
        contextIsolation: true,
        backgroundThrottling: false,
        // Mic access in a hidden window needs autoplay/media permissions relaxed.
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    win.setIgnoreMouseEvents(true, { forward: false })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('did-finish-load', () => {
      this.resolveReady()
      this.push()
    })
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning')
        log.warn(`[overlay renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
    win.on('closed', () => {
      this.win = null
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
    this.win = win
    return win
  }

  get webContents(): Electron.WebContents | null {
    return this.win?.webContents ?? null
  }

  whenReady(): Promise<void> {
    return this.ready
  }

  configureVisibility(showWhenIdle: boolean, position: OverlayPosition): void {
    this.showWhenIdle = showWhenIdle
    this.position = position
    this.applyVisibility()
  }

  setState(state: OverlayState): void {
    this.state = state
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    this.push()
    this.applyVisibility()
    if (state.phase === 'success' || state.phase === 'error') {
      this.hideTimer = setTimeout(
        () => this.setState({ phase: 'idle' }),
        state.phase === 'error' ? 2800 : 1100
      )
    }
  }

  getState(): OverlayState {
    return this.state
  }

  playSound(name: SoundName): void {
    this.win?.webContents.send(IPC.overlayPlaySound, name)
  }

  send(channel: string, payload: unknown): void {
    this.win?.webContents.send(channel, payload)
  }

  private push(): void {
    this.win?.webContents.send(IPC.overlayState, this.state)
  }

  private applyVisibility(): void {
    if (!this.win) return
    const active = this.state.phase !== 'idle'
    if (active || this.showWhenIdle) {
      this.reposition()
      if (!this.win.isVisible()) this.win.showInactive()
    } else if (this.win.isVisible()) {
      this.win.hide()
    }
  }

  reposition(): void {
    if (!this.win) return
    try {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const area = display.workArea
      let x = Math.round(area.x + (area.width - WIDTH) / 2)
      let y = Math.round(area.y + area.height - HEIGHT - MARGIN
      if (this.position === 'top-center') y = area.y + MARGIN
      if (this.position === 'bottom-right') x = area.x + area.width - WIDTH - MARGIN
      const b = this.win.getBounds()
      if (b.x !== x || b.y !== y) this.win.setBounds({ x, y, width: WIDTH, height: HEIGHT })
    } catch (err) {
      log.warn('reposition failed', err)
    }
  }

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }
}
