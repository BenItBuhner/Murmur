import { join } from 'node:path'
import { BrowserWindow, shell, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import icon from '../../../resources/icon.png?asset'
import { createLogger } from '../logger'

const log = createLogger('window')
let win: BrowserWindow | null = null
let quitting = false
/** Origin the packaged renderer is served from (`murmur://app`); dev builds use Vite's server. */
let rendererOriginUrl: string | null = null

export function setQuitting(v: boolean): void {
  quitting = v
}

export function setRendererOrigin(origin: string): void {
  rendererOriginUrl = origin
}

export function getMainWindow(): BrowserWindow | null {
  return win
}

function loadRenderer(target: BrowserWindow): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void target.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`)
  } else if (rendererOriginUrl) {
    void target.loadURL(`${rendererOriginUrl}/index.html`)
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Native chrome colours: the window background before first paint and the Windows caption buttons. */
export interface ChromeColors {
  background: string
  foreground: string
}

/** Neutral defaults used until the renderer reports the palette it actually resolved. */
export function defaultChrome(theme: 'light' | 'dark'): ChromeColors {
  return theme === 'dark'
    ? { background: '#0f0f10', foreground: '#e7e5e4' }
    : { background: '#fafaf9', foreground: '#1c1917' }
}

export function createMainWindow(chrome: ChromeColors): BrowserWindow {
  if (win) return win
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: chrome.background,
    title: 'Murmur',
    icon: nativeImage.createFromPath(icon),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: chrome.background,
            symbolColor: chrome.foreground,
            height: 40
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // The hidden window keeps the Clerk session alive and answers token requests for the
      // main-process sync engine; throttled timers would delay token refreshes.
      backgroundThrottling: false
    }
  })
  win.on('ready-to-show', () => {
    if (!win?.isVisible() && shouldShowOnReady) win?.show()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting || !win) return
    log.error(`renderer crashed (${details.reason}); reloading`)
    loadRenderer(win)
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning')
      log.warn(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  loadRenderer(win)
  return win
}

let shouldShowOnReady = true
export function setShowOnReady(v: boolean): void {
  shouldShowOnReady = v
}

export function showMainWindow(route?: string): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (route) win.webContents.send(IPC.navigate, route)
}

export function updateChrome(chrome: ChromeColors): void {
  if (!win) return
  try {
    win.setBackgroundColor(chrome.background)
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: chrome.background,
        symbolColor: chrome.foreground,
        height: 40
      })
    }
  } catch {
    // ignore
  }
}
