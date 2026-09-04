import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createLogger } from '../logger'

const log = createLogger('linux-inject')

export type LinuxTool = 'xdotool' | 'wtype' | 'ydotool' | null

const toolCache = new Map<string, boolean>()

function which(bin: string): boolean {
  if (toolCache.has(bin)) return toolCache.get(bin)!
  const dirs = (process.env.PATH ?? '').split(':')
  const found = dirs.some((d) => {
    try {
      accessSync(`${d}/${bin}`, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
  toolCache.set(bin, found)
  return found
}

export function sessionType(): 'wayland' | 'x11' | 'unknown' {
  const t = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase()
  if (t === 'wayland' || process.env.WAYLAND_DISPLAY) return 'wayland'
  if (t === 'x11' || process.env.DISPLAY) return 'x11'
  return 'unknown'
}

/** Pick the injection tool for the current session. */
export function pickTool(): LinuxTool {
  const session = sessionType()
  if (session === 'wayland') {
    if (which('wtype')) return 'wtype'
    if (which('ydotool')) return 'ydotool'
    if (which('xdotool')) return 'xdotool' // XWayland apps only
    return null
  }
  if (which('xdotool')) return 'xdotool'
  if (which('ydotool')) return 'ydotool'
  return null
}

function run(bin: string, args: string[], timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${bin} failed: ${stderr || err.message}`))
      else resolve()
    })
  })
}

export async function pasteShortcut(tool: LinuxTool): Promise<void> {
  switch (tool) {
    case 'xdotool':
      return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
    case 'wtype':
      return run('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl'])
    case 'ydotool':
      // 29 = LEFTCTRL, 47 = V (Linux input event codes)
      return run('ydotool', ['key', '29:1', '47:1', '47:0', '29:0'])
    default:
      throw new Error('No input tool available (install xdotool, wtype, or ydotool)')
  }
}

export async function typeText(tool: LinuxTool, text: string): Promise<void> {
  switch (tool) {
    case 'xdotool':
      return run('xdotool', ['type', '--clearmodifiers', '--delay', '0', '--', text], 15000)
    case 'wtype':
      return run('wtype', ['--', text], 15000)
    case 'ydotool':
      return run('ydotool', ['type', '--', text], 15000)
    default:
      throw new Error('No input tool available (install xdotool, wtype, or ydotool)')
  }
}

export async function pressEnter(tool: LinuxTool): Promise<void> {
  switch (tool) {
    case 'xdotool':
      return run('xdotool', ['key', '--clearmodifiers', 'Return'])
    case 'wtype':
      return run('wtype', ['-k', 'Return'])
    case 'ydotool':
      return run('ydotool', ['key', '28:1', '28:0'])
    default:
      throw new Error('No input tool available')
  }
}

export async function copyShortcut(tool: LinuxTool): Promise<void> {
  switch (tool) {
    case 'xdotool':
      return run('xdotool', ['key', '--clearmodifiers', 'ctrl+c'])
    case 'wtype':
      return run('wtype', ['-M', 'ctrl', 'c', '-m', 'ctrl'])
    case 'ydotool':
      return run('ydotool', ['key', '29:1', '46:1', '46:0', '29:0'])
    default:
      throw new Error('No input tool available')
  }
}

export async function activeWindowX11(): Promise<{
  title: string
  app: string
  pid?: number
} | null> {
  if (!which('xdotool')) return null
  const exec = (args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile('xdotool', args, { timeout: 400 }, (err, out) => resolve(err ? '' : out.trim()))
    )
  try {
    const id = await exec(['getactivewindow'])
    if (!id) return null
    const [title, pidStr] = await Promise.all([
      exec(['getwindowname', id]),
      exec(['getwindowpid', id])
    ])
    const pid = Number(pidStr) || undefined
    let app = ''
    if (pid) {
      try {
        const { readFileSync } = await import('node:fs')
        app = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      } catch {
        // ignore
      }
    }
    return { title, app, pid }
  } catch (err) {
    log.debug('activeWindowX11 failed', err)
    return null
  }
}
