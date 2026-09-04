import { execFile } from 'node:child_process'
import { createLogger } from '../logger'

const log = createLogger('darwin-inject')

/**
 * macOS injection backend. Synthetic keyboard events go through AppleScript / System Events,
 * which is what most dictation utilities (including Wispr Flow) rely on. The app must be granted
 * Accessibility permission (System Settings → Privacy & Security → Accessibility); the first
 * keystroke attempt triggers the OS prompt.
 *
 * Untested in CI (no macOS hardware available); kept deliberately simple and dependency-free.
 */

function runOsascript(script: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`osascript failed: ${stderr || err.message}`))
      else resolve(stdout.trim())
    })
  })
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function pasteShortcut(): Promise<void> {
  await runOsascript('tell application "System Events" to keystroke "v" using command down')
}

export async function copyShortcut(): Promise<void> {
  await runOsascript('tell application "System Events" to keystroke "c" using command down')
}

export async function pressEnter(): Promise<void> {
  // key code 36 = Return
  await runOsascript('tell application "System Events" to key code 36')
}

export async function typeText(text: string, chunkSize = 64, chunkDelayMs = 2): Promise<void> {
  // `keystroke` handles Unicode but embedded newlines must become Return key presses.
  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    for (let i = 0; i < line.length; i += Math.max(1, chunkSize)) {
      const chunk = line.slice(i, i + Math.max(1, chunkSize))
      if (chunk)
        await runOsascript(
          `tell application "System Events" to keystroke "${escapeAppleScript(chunk)}"`,
          15000
        )
      if (chunkDelayMs > 0) await new Promise((r) => setTimeout(r, chunkDelayMs))
    }
    if (li < lines.length - 1) await pressEnter()
  }
}

export async function activeWindowDarwin(): Promise<{ title: string; app: string } | null> {
  try {
    const app = await runOsascript(
      'tell application "System Events" to get name of first application process whose frontmost is true',
      1200
    )
    let title = ''
    try {
      title = await runOsascript(
        'tell application "System Events" to get title of front window of (first application process whose frontmost is true)',
        1200
      )
    } catch {
      // Some apps expose no window title; the process name is enough for app rules.
    }
    return { title, app }
  } catch (err) {
    log.debug('activeWindowDarwin failed', err)
    return null
  }
}
