import { join } from 'node:path'
import { BrowserWindow, shell, nativeImage } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import icon from '../../../resources/icon.png?asset'
import { createLogger } from '../logger'

const log = createLogger('window')
let win: BrowserWindow | null = null
let quitting = false

export function setQuitting(v: boolean): void {
  quitting = v
}

export function getMainWindow(): BrowserWindow | null {
  return win
}

export function createMainWindow(theme: 'light' | 'dark'): BrowserWindow {
  if (win) return win
  const dark = theme === 'dark'
  win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: dark ? '#0f0f10' : '#fafaf9',
    title: 'Murmur',
    icon: nativeImage.createFromPath(icon),
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: dark ? '#0f0f10' : '#fafaf9',
            symbolColor: dark ? '#e7e5e4' : '#1c1917',
            height: 40
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('ready-to-show', () => {
    if (!win?.isVisible() && shouldShowOnReady) win?.show()
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
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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

export function updateTitleBar(theme: 'light' | 'dark'): void {
  if (!win || process.platform !== 'win32') return
  const dark = theme === 'dark'
  try {
    win.setTitleBarOverlay({
      color: dark ? '#0f0f10' : '#fafaf9',
      symbolColor: dark ? '#e7e5e4' : '#1c1917',
      height: 40
    })
    win.setBackgroundColor(dark ? '#0f0f10' : '#fafaf9')
  } catch {
    // ignore
  }
}
