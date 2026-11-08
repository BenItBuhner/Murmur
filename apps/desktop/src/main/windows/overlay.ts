import { join } from 'node:path'
import { guardWebContents } from './external'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { OverlayPosition } from '@shared/settings'
import type { OverlayState } from '@shared/types'
import { IPC, type SoundName } from '@shared/ipc'
import { createLogger } from '../logger'

const log = createLogger('overlay')

const WIDTH = 360
const HEIGHT = 120
/**
 * A plan limit has more to say (two lines and up to four buttons): the window grows for it. A
 * Murmur service that is unavailable is explained on the same two lines.
 */
const LIMIT_WIDTH = 600
const LIMIT_HEIGHT = 160
const MARGIN = 28
/** How long the pill takes to slide out from under the screen edge, or back under it. */
const SLIDE_MS = 220
const SLIDE_FRAME_MS = 16

/** How long results stay up. An error that can be retried waits for the user much longer. */
const SUCCESS_HOLD_MS = 1100
const ERROR_HOLD_MS = 2800
const RETRY_HOLD_MS = 15000
/**
 * A limit refusal or a service notice is read, not glanced at; a text inserted unformatted
 * deserves a beat more too.
 */
const LIMIT_HOLD_MS = 20000
const SOFT_LIMIT_HOLD_MS = 5000

/** The pill is explaining something on two lines: a plan limit, or a Murmur service that is down. */
function explains(state: OverlayState): boolean {
  return !!state.limit || (state.phase === 'error' && !!state.service)
}

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
  /** Idle, the pill waits just past the screen edge and slides into view when dictation starts. */
  private tuck = false
  private slideTimer: NodeJS.Timeout | null = null
  private ready: Promise<void>
  private resolveReady!: () => void
  /** The pill has buttons right now (a retryable error), so the window must take clicks. */
  private interactive = false

  constructor() {
    this.ready = new Promise((r) => (this.resolveReady = r))
    ipcMain.on(IPC.overlayHover, (_e, over: boolean) => this.onHover(!!over))
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
    guardWebContents(win.webContents)
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

  configureVisibility(showWhenIdle: boolean, position: OverlayPosition, tuck = false): void {
    this.showWhenIdle = showWhenIdle
    this.position = position
    this.tuck = tuck
    this.applyVisibility()
  }

  setState(state: OverlayState): void {
    this.state = state
    this.push()
    this.applyVisibility()
    this.setInteractive(
      state.phase === 'error' && (!!state.retryId || !!state.limit || !!state.service)
    )
    this.armHideTimer()
  }

  /** The window's size for the current state: roomier while the pill is explaining something. */
  private size(): { width: number; height: number } {
    if (!explains(this.state)) return { width: WIDTH, height: HEIGHT }
    return { width: LIMIT_WIDTH, height: this.state.phase === 'error' ? LIMIT_HEIGHT : HEIGHT }
  }

  private clearHideTimer(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  /** Results go away on their own; an error that can be retried waits for the user much longer. */
  private armHideTimer(): void {
    this.clearHideTimer()
    const { phase, retryId, limit, service } = this.state
    if (phase !== 'success' && phase !== 'error') return
    const hold =
      phase === 'success'
        ? limit
          ? SOFT_LIMIT_HOLD_MS
          : SUCCESS_HOLD_MS
        : limit || service
          ? LIMIT_HOLD_MS
          : retryId
            ? RETRY_HOLD_MS
            : ERROR_HOLD_MS
    this.hideTimer = setTimeout(() => this.setState({ phase: 'idle' }), hold)
  }

  /** The user waved the pill's message away. */
  dismiss(): void {
    if (this.state.phase === 'error' || this.state.phase === 'success') {
      this.setState({ phase: 'idle' })
    }
  }

  getState(): OverlayState {
    return this.state
  }

  /**
   * The window is click-through except while the pill has buttons. Even then only the pill itself
   * should catch the mouse: Windows and macOS keep forwarding pointer moves through an ignored
   * window, so the renderer reports when the pointer is over the pill and the window takes clicks
   * just then. Linux cannot forward, so there the whole (small) window takes clicks meanwhile.
   */
  private setInteractive(on: boolean): void {
    if (on === this.interactive) return
    this.interactive = on
    if (!this.win) return
    if (!on) this.win.setIgnoreMouseEvents(true, { forward: false })
    else if (process.platform === 'linux') this.win.setIgnoreMouseEvents(false)
    else this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  /** A pill the pointer is over is being read or aimed at: it never times out underneath the user. */
  private onHover(over: boolean): void {
    if (!this.win || !this.interactive) return
    if (over) this.clearHideTimer()
    else this.armHideTimer()
    if (process.platform !== 'linux') this.win.setIgnoreMouseEvents(!over, { forward: true })
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
    if (this.tuck) {
      const wasVisible = this.win.isVisible()
      if (!wasVisible) {
        // Start hidden under the edge so the first appearance slides in too.
        this.stopSlide()
        const t = this.target(true)
        if (t) this.win.setBounds(t)
        this.win.showInactive()
      }
      this.reposition(true)
    } else if (active || this.showWhenIdle) {
      this.stopSlide()
      this.reposition()
      if (!this.win.isVisible()) this.win.showInactive()
    } else if (this.win.isVisible()) {
      this.stopSlide()
      this.win.hide()
    }
  }

  /**
   * Where the window belongs now. Tucked, it sits entirely past the screen's own edge (not the
   * work area's, so it also clears the taskbar or dock) on the display the pointer is on.
   */
  private target(tucked = this.tuck && this.state.phase === 'idle'): Electron.Rectangle | null {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const area = display.workArea
    const { width, height } = this.size()
    const top = this.position === 'top-center'
    let x = Math.round(area.x + (area.width - width) / 2)
    let y = Math.round(area.y + area.height - height - MARGIN)
    if (top) y = area.y + MARGIN
    if (this.position === 'bottom-right') x = area.x + area.width - width - MARGIN
    if (tucked) {
      const b = display.bounds
      y = top ? b.y - height : b.y + b.height
    }
    return { x, y, width, height }
  }

  reposition(animate = false): void {
    if (!this.win) return
    try {
      const t = this.target()
      if (!t) return
      const b = this.win.getBounds()
      if (b.x === t.x && b.y === t.y && b.width === t.width && b.height === t.height) return
      // Slide only along the edge axis on the same display; anything else jumps.
      if (animate && b.x === t.x && b.width === t.width && b.height === t.height) this.slide(b.y, t)
      else {
        this.stopSlide()
        this.win.setBounds(t)
      }
    } catch (err) {
      log.warn('reposition failed', err)
    }
  }

  private stopSlide(): void {
    if (this.slideTimer) {
      clearInterval(this.slideTimer)
      this.slideTimer = null
    }
  }

  /** Eases the window from `fromY` to its target, like a sheet rising from under the screen. */
  private slide(fromY: number, to: Electron.Rectangle): void {
    this.stopSlide()
    const start = Date.now()
    this.slideTimer = setInterval(() => {
      if (!this.win) return this.stopSlide()
      const p = Math.min(1, (Date.now() - start) / SLIDE_MS)
      const e = 1 - Math.pow(1 - p, 3)
      this.win.setBounds({ ...to, y: Math.round(fromY + (to.y - fromY) * e) })
      if (p >= 1) this.stopSlide()
    }, SLIDE_FRAME_MS)
  }

  destroy(): void {
    this.stopSlide()
    this.win?.destroy()
    this.win = null
  }
}
