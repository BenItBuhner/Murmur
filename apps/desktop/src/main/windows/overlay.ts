import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, shell, type Rectangle } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { OverlayBarSettings, OverlayPosition } from '@shared/settings'
import type { OverlayGestureMessage, SoundName } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { OverlayState } from '@shared/types'
import {
  OVERLAY_LIMIT_HEIGHT,
  OVERLAY_LIMIT_WIDTH,
  OVERLAY_WINDOW_HEIGHT,
  OVERLAY_WINDOW_WIDTH,
  barCenterFromWindow,
  centerForFractions,
  clampBarCenter,
  clampBarSize,
  defaultOverlayBar,
  fractionsForCenter,
  nearestPreset,
  presetWindowOrigin,
  resizeBar,
  windowOriginForBarCenter,
  type BarEdge,
  type WorkArea
} from '@shared/overlay-bar'
import { createLogger } from '../logger'

const log = createLogger('overlay')

const WIDTH = OVERLAY_WINDOW_WIDTH
const HEIGHT = OVERLAY_WINDOW_HEIGHT
/**
 * A plan limit has more to say (two lines and up to four buttons): the window grows for it. A
 * Murmur service that is unavailable is explained on the same two lines.
 */
const LIMIT_WIDTH = OVERLAY_LIMIT_WIDTH
const LIMIT_HEIGHT = OVERLAY_LIMIT_HEIGHT
/** A gesture shorter than this is a click, not a move, so the bar stays where it was. */
const GESTURE_SLOP_PX = 4

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
  private bar: OverlayBarSettings = defaultOverlayBar()
  private ready: Promise<void>
  private resolveReady!: () => void
  /** The pill has buttons right now (a retryable error), so the window must take clicks. */
  private interactive = false
  /** The pointer is over the bar or the pill, so the window takes the click that follows. */
  private hovering = false
  private gesture: {
    kind: 'move' | 'resize'
    edge: BarEdge
    startCursor: { x: number; y: number }
    startBounds: Rectangle
    startSize: { width: number; height: number }
    moved: boolean
  } | null = null
  /** Persists a placement once a drag or resize ends. */
  private onCommit: ((position: OverlayPosition, bar: OverlayBarSettings) => void) | null = null

  constructor() {
    this.ready = new Promise((r) => (this.resolveReady = r))
    ipcMain.on(IPC.overlayHover, (_e, over: boolean) => this.onHover(!!over))
    ipcMain.on(IPC.overlayGesture, (_e, payload: unknown) => {
      if (isGesture(payload)) this.onGesture(payload)
    })
  }

  /** Where a finished drag should be saved. Set once, from the process that owns the settings. */
  setCommitHandler(handler: (position: OverlayPosition, bar: OverlayBarSettings) => void): void {
    this.onCommit = handler
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
    win.setIgnoreMouseEvents(true, { forward: true })
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
      this.pushBar()
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

  configureVisibility(
    showWhenIdle: boolean,
    position: OverlayPosition,
    bar: OverlayBarSettings = defaultOverlayBar()
  ): void {
    this.showWhenIdle = showWhenIdle
    this.position = position
    const size = clampBarSize(bar.width, bar.height)
    this.bar = {
      anchor: bar.anchor,
      x: clampUnit(bar.x),
      y: clampUnit(bar.y),
      width: size.width,
      height: size.height
    }
    this.pushBar()
    if (this.gesture?.kind === 'move') return
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
    this.applyMouse()
  }

  /**
   * Clicks pass through the window except where the pointer is on the bar (so it can be dragged)
   * or the pill has buttons. Moves are forwarded either way, which is how the bar learns the
   * pointer is over it.
   */
  private applyMouse(): void {
    if (!this.win) return
    if (this.gesture || this.hovering) {
      this.win.setIgnoreMouseEvents(false)
      return
    }
    if (this.interactive && process.platform === 'linux') {
      this.win.setIgnoreMouseEvents(false)
      return
    }
    this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  /** A pill the pointer is over is being read or aimed at: it never times out underneath the user. */
  private onHover(over: boolean): void {
    this.hovering = over
    if (this.interactive) {
      if (over) this.clearHideTimer()
      else this.armHideTimer()
    }
    this.applyMouse()
  }

  private onGesture(message: OverlayGestureMessage): void {
    if (!this.win) return
    if (message.phase === 'start') {
      const edge = message.edge ?? 'e'
      this.gesture = {
        kind: message.kind,
        edge,
        startCursor: { x: message.screenX, y: message.screenY },
        startBounds: this.win.getBounds(),
        startSize: { width: this.bar.width, height: this.bar.height },
        moved: false
      }
      this.applyMouse()
      return
    }
    const gesture = this.gesture
    if (!gesture) return
    if (message.phase === 'cancel') {
      this.gesture = null
      this.bar = { ...this.bar, width: gesture.startSize.width, height: gesture.startSize.height }
      this.pushBar()
      this.reposition()
      this.applyMouse()
      return
    }
    const dx = message.screenX - gesture.startCursor.x
    const dy = message.screenY - gesture.startCursor.y
    if (!gesture.moved && Math.hypot(dx, dy) < GESTURE_SLOP_PX) {
      if (message.phase === 'end') {
        this.gesture = null
        this.applyMouse()
      }
      return
    }
    gesture.moved = true
    if (gesture.kind === 'resize') {
      const size = resizeBar(gesture.edge, gesture.startSize, dx, dy)
      this.bar = { ...this.bar, width: size.width, height: size.height }
      this.pushBar()
    } else {
      this.win.setBounds({
        ...gesture.startBounds,
        x: Math.round(gesture.startBounds.x + dx),
        y: Math.round(gesture.startBounds.y + dy)
      })
    }
    if (message.phase === 'end') this.finishGesture(gesture)
  }

  /** Write the bar where the gesture left it: a nearby preset, or a free spot that can leave center. */
  private finishGesture(gesture: NonNullable<OverlayWindow['gesture']>): void {
    this.gesture = null
    if (!this.win) return
    if (gesture.kind === 'move') {
      const area = this.workArea()
      if (area) {
        const bounds = this.win.getBounds()
        const center = clampBarCenter(
          barCenterFromWindow(bounds, this.bar.height),
          area,
          this.bar.width,
          this.bar.height
        )
        const preset = nearestPreset(center, area, bounds.width, bounds.height, this.bar.height)
        if (preset) {
          this.position = preset
          this.bar = { ...this.bar, anchor: 'preset' }
        } else {
          const fractions = fractionsForCenter(center, area)
          this.bar = { ...this.bar, anchor: 'free', x: fractions.x, y: fractions.y }
        }
      }
    }
    this.onCommit?.(this.position, this.bar)
    this.reposition()
    this.applyMouse()
  }

  private workArea(): WorkArea | null {
    if (!this.win) return null
    try {
      const bounds = this.win.getBounds()
      const display = screen.getDisplayNearestPoint({
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2)
      })
      return display.workArea
    } catch (err) {
      log.warn('work area unavailable', err)
      return null
    }
  }

  private pushBar(): void {
    this.win?.webContents.send(IPC.overlayBar, { width: this.bar.width, height: this.bar.height })
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
      const { width, height } = this.size()
      const origin =
        this.bar.anchor === 'free'
          ? windowOriginForBarCenter(
              clampBarCenter(
                centerForFractions(this.bar.x, this.bar.y, area),
                area,
                this.bar.width,
                this.bar.height
              ),
              width,
              height,
              this.bar.height
            )
          : presetWindowOrigin(this.position, area, width, height)
      const b = this.win.getBounds()
      if (b.x !== origin.x || b.y !== origin.y || b.width !== width || b.height !== height) {
        this.win.setBounds({ x: origin.x, y: origin.y, width, height })
      }
    } catch (err) {
      log.warn('reposition failed', err)
    }
  }

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

const EDGES: readonly BarEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function isGesture(value: unknown): value is OverlayGestureMessage {
  if (typeof value !== 'object' || value === null) return false
  const gesture = value as OverlayGestureMessage
  const phaseOk =
    gesture.phase === 'start' ||
    gesture.phase === 'move' ||
    gesture.phase === 'end' ||
    gesture.phase === 'cancel'
  const kindOk = gesture.kind === 'move' || gesture.kind === 'resize'
  const edgeOk = gesture.edge === undefined || EDGES.includes(gesture.edge)
  return (
    phaseOk &&
    kindOk &&
    edgeOk &&
    typeof gesture.screenX === 'number' &&
    typeof gesture.screenY === 'number' &&
    Number.isFinite(gesture.screenX) &&
    Number.isFinite(gesture.screenY)
  )
}
