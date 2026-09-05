import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { TokenRequest, TokenResponse } from '@shared/cloud'
import { createLogger } from '../logger'

const log = createLogger('cloud:token')

interface Pending {
  resolve: (token: string | null) => void
  timer: NodeJS.Timeout
}

/**
 * Clerk lives in the renderer (it needs a browser environment); the Convex client lives in the main
 * process (it must keep syncing while the window is hidden). This bridge lets main ask the renderer
 * for a fresh Convex JWT and waits for the answer.
 */
export class TokenBridge {
  private pending = new Map<string, Pending>()
  private readonly onResponse = (_e: Electron.IpcMainEvent, res: TokenResponse): void => {
    const entry = this.pending.get(res.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(res.id)
    if (res.error) log.warn(`token request failed: ${res.error}`)
    entry.resolve(res.token)
  }

  constructor(
    private readonly target: () => WebContents | null,
    private readonly timeoutMs = 20_000
  ) {
    ipcMain.on(IPC.cloudTokenResponse, this.onResponse)
  }

  request(forceRefresh: boolean): Promise<string | null> {
    const contents = this.target()
    if (!contents || contents.isDestroyed()) {
      log.debug('no renderer available for token request')
      return Promise.resolve(null)
    }
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        log.warn('token request timed out')
        resolve(null)
      }, this.timeoutMs)
      this.pending.set(id, { resolve, timer })
      const message: TokenRequest = { id, forceRefresh }
      contents.send(IPC.cloudTokenRequest, message)
    })
  }

  dispose(): void {
    ipcMain.removeListener(IPC.cloudTokenResponse, this.onResponse)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve(null)
    }
    this.pending.clear()
  }
}
