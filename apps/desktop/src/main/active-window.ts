import type { ActiveWindowInfo } from '@shared/types'
import { activeWindowDarwin } from './inject/darwin'
import { activeWindowX11 } from './inject/linux'
import { foregroundWindow } from './inject/win32'

let cache: { at: number; info: ActiveWindowInfo } | null = null

/** Best-effort focused window lookup; cached briefly because the hotkey path is latency-critical. */
export async function getActiveWindow(): Promise<ActiveWindowInfo> {
  if (cache && Date.now() - cache.at < 400) return cache.info
  let info: ActiveWindowInfo = { title: '', app: '' }
  try {
    if (process.platform === 'win32') {
      info = foregroundWindow() ?? info
    } else if (process.platform === 'linux') {
      info = (await activeWindowX11()) ?? info
    } else if (process.platform === 'darwin') {
      info = (await activeWindowDarwin()) ?? info
    }
  } catch {
    // ignore
  }
  cache = { at: Date.now(), info }
  return info
}
