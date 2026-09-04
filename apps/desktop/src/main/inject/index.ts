import { clipboard, nativeImage, type NativeImage } from 'electron'
import type { InjectionMethod } from '@shared/settings'
import { createLogger } from '../logger'
import * as darwin from './darwin'
import * as linux from './linux'
import * as win from './win32'

const log = createLogger('inject')

export interface InjectOptions {
  method: InjectionMethod
  restoreClipboard: boolean
  restoreClipboardDelayMs: number
  typeChunkSize: number
  typeChunkDelayMs: number
  pressEnter?: boolean
  /** Await this before touching the keyboard (hotkey keys must be released). */
  waitForKeysUp?: () => Promise<boolean>
}

export interface InjectResult {
  ok: boolean
  method: 'paste' | 'type' | 'clipboard'
  ms: number
  error?: string
}

interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  image: NativeImage | null
}

function snapshotClipboard(): ClipboardSnapshot {
  let image: NativeImage | null = null
  try {
    const img = clipboard.readImage()
    image = img.isEmpty() ? null : img
  } catch {
    image = null
  }
  return {
    text: safe(() => clipboard.readText()),
    html: safe(() => clipboard.readHTML()),
    rtf: safe(() => clipboard.readRTF()),
    image
  }
}

function restoreClipboard(snap: ClipboardSnapshot): void {
  try {
    if (snap.image && !snap.text && !snap.html) {
      clipboard.writeImage(snap.image)
      return
    }
    const data: Electron.Data = {}
    if (snap.text) data.text = snap.text
    if (snap.html) data.html = snap.html
    if (snap.rtf) data.rtf = snap.rtf
    if (snap.image) data.image = snap.image
    if (Object.keys(data).length) clipboard.write(data)
    else clipboard.clear()
  } catch (err) {
    log.warn('clipboard restore failed', err)
  }
}

function safe(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ''
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function injectionBackendName(): string {
  if (process.platform === 'win32')
    return win.win32Available() ? 'win32 SendInput (koffi)' : 'clipboard only (koffi unavailable)'
  if (process.platform === 'linux') {
    const tool = linux.pickTool()
    return tool
      ? `${tool} (${linux.sessionType()})`
      : `clipboard only (${linux.sessionType()}, no xdotool/wtype/ydotool)`
  }
  if (process.platform === 'darwin') return 'osascript (System Events)'
  return 'clipboard only'
}

function resolveMethod(method: InjectionMethod, text: string): 'paste' | 'type' | 'clipboard' {
  if (method !== 'auto') return method
  if (process.platform === 'win32') return win.win32Available() ? 'paste' : 'clipboard'
  if (process.platform === 'linux') return linux.pickTool() ? 'paste' : 'clipboard'
  if (process.platform === 'darwin') return 'paste'
  void text
  return 'clipboard'
}

async function sendPaste(): Promise<void> {
  if (process.platform === 'win32') {
    win.releaseModifiers()
    if (!win.keyTap(win.VK.V, [win.VK.CONTROL])) throw new Error('SendInput Ctrl+V failed')
    return
  }
  if (process.platform === 'linux') return linux.pasteShortcut(linux.pickTool())
  if (process.platform === 'darwin') return darwin.pasteShortcut()
  throw new Error('Paste not supported on this platform')
}

async function sendType(text: string, opts: InjectOptions): Promise<void> {
  if (process.platform === 'win32') {
    win.releaseModifiers()
    if (!(await win.typeUnicode(text, opts.typeChunkSize, opts.typeChunkDelayMs)))
      throw new Error('SendInput unicode typing failed')
    return
  }
  if (process.platform === 'linux') return linux.typeText(linux.pickTool(), text)
  if (process.platform === 'darwin')
    return darwin.typeText(text, opts.typeChunkSize, opts.typeChunkDelayMs)
  throw new Error('Typing not supported on this platform')
}

export async function sendEnter(): Promise<void> {
  if (process.platform === 'win32') {
    win.keyTap(win.VK.RETURN)
    return
  }
  if (process.platform === 'linux') return linux.pressEnter(linux.pickTool())
  if (process.platform === 'darwin') return darwin.pressEnter()
}

/**
 * Put `text` where the user's cursor is. Default strategy is paste-through-clipboard (universal,
 * fast, handles any Unicode) with the previous clipboard restored shortly afterwards, exactly the
 * behaviour people expect from Wispr Flow. Direct typing avoids the clipboard entirely.
 */
export async function injectText(text: string, opts: InjectOptions): Promise<InjectResult> {
  const started = performance.now()
  const method = resolveMethod(opts.method, text)
  try {
    if (opts.waitForKeysUp) {
      const released = await opts.waitForKeysUp()
      if (!released) log.warn('Hotkey still held during injection; proceeding anyway')
    }

    if (method === 'type') {
      await sendType(text, opts)
      if (opts.pressEnter) await sendEnter()
      return { ok: true, method, ms: Math.round(performance.now() - started) }
    }

    const snap = opts.restoreClipboard ? snapshotClipboard() : null
    clipboard.writeText(text)
    if (method === 'clipboard') {
      return { ok: true, method, ms: Math.round(performance.now() - started) }
    }
    // Let the clipboard owner change settle before the target app reads it.
    await sleep(process.platform === 'win32' ? 20 : 35)
    await sendPaste()
    if (opts.pressEnter) {
      await sleep(40)
      await sendEnter()
    }
    if (snap) {
      // Restore later so apps with delayed clipboard rendering still receive our text.
      setTimeout(
        () => {
          const current = safe(() => clipboard.readText())
          if (current === text) restoreClipboard(snap)
        },
        Math.max(50, opts.restoreClipboardDelayMs)
      )
    }
    return { ok: true, method, ms: Math.round(performance.now() - started) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`inject via ${method} failed: ${message}`)
    // Leave the text on the clipboard so the user can still paste manually.
    try {
      clipboard.writeText(text)
    } catch {
      // ignore
    }
    return { ok: false, method, ms: Math.round(performance.now() - started), error: message }
  }
}

/**
 * Command mode needs the highlighted text. There is no cross-app selection API on Windows/Linux,
 * so we copy it through the clipboard and restore the clipboard afterwards.
 */
export async function readSelection(): Promise<{ text: string; restore: () => void }> {
  // On X11 the PRIMARY selection already holds whatever is highlighted, no Ctrl+C and no clipboard
  // clobber required. This sidesteps the Electron-vs-app CLIPBOARD ownership race entirely.
  if (process.platform === 'linux') {
    try {
      const primary = clipboard.readText('selection')
      if (primary && primary.trim()) return { text: primary, restore: () => undefined }
    } catch {
      // fall through to the Ctrl+C path
    }
  }
  const snap = snapshotClipboard()
  const marker = `\u200b__murmur_marker_${Date.now()}__`
  clipboard.writeText(marker)
  try {
    if (process.platform === 'win32') {
      win.releaseModifiers()
      win.keyTap(win.VK.C, [win.VK.CONTROL])
    } else if (process.platform === 'linux') {
      const tool = linux.pickTool()
      log.debug(`readSelection: copying via ${tool}`)
      await linux.copyShortcut(tool)
    } else if (process.platform === 'darwin') {
      await darwin.copyShortcut()
    }
  } catch (err) {
    log.warn('copy shortcut failed', err)
  }
  let text = ''
  for (let i = 0; i < 24; i++) {
    await sleep(25)
    const cur = safe(() => clipboard.readText())
    if (cur && cur !== marker) {
      text = cur
      break
    }
  }
  log.debug(`readSelection: captured ${text.length} chars`)
  return { text, restore: () => restoreClipboard(snap) }
}

export { nativeImage }
