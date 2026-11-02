import { shell, type WebContents } from 'electron'

/**
 * Only web and mail links leave the app. `shell.openExternal` hands any scheme to the OS, and some
 * (file:, smb:, ms-msdt: and other protocol handlers) can run code, so a link that reached a
 * window from an update feed, a provider error or pasted text must not be able to name one.
 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

export function openExternalSafe(raw: string): void {
  if (isSafeExternalUrl(raw)) void shell.openExternal(raw)
}

/**
 * New windows are never created; safe links open in the browser. The window itself never navigates
 * away from the page it loaded (a link without target=_blank would otherwise replace the app UI with
 * a remote page that keeps the preload bridge).
 */
export function guardWebContents(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (url === wc.getURL()) return
    event.preventDefault()
    openExternalSafe(url)
  })
}
