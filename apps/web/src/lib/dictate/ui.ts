/** Size of the small window: room for the button, the status and a few lines of text. */
export const MINI_SIZE = { width: 380, height: 600 }
export const MINI_FEATURES = `popup=yes,width=${MINI_SIZE.width},height=${MINI_SIZE.height - 40}`

export function miniUrl(href: string): string {
  const url = new URL(href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('mini', '1')
  return url.toString()
}

/** Each dictation goes on after the text already there, separated as a new sentence would be. */
export function appendDictation(current: string, next: string): string {
  const text = next.trim()
  if (!text) return current
  if (!current.trim()) return text
  if (/\n\s*$/.test(current)) return current + text
  const sep = text.includes('\n') || /\n/.test(current) ? '\n\n' : ' '
  return current.replace(/\s+$/, '') + sep + text
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}
