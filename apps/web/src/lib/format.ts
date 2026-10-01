const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** `92.4 MB`: one decimal below 10 units, none above, like a file manager. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

/** The typing speed the apps compare dictation against (Home's "Time saved"). */
export const TYPING_WPM = 40

/** Words per minute of speech across every dictation, as the apps' Home shows it; 0 before anything was said. */
export function wordsPerMinute(totalWords: number, totalSpeechMs: number): number {
  const minutes = totalSpeechMs / 60_000
  return minutes > 0 ? Math.round(totalWords / minutes) : 0
}

/** How much longer typing those words at [TYPING_WPM] would have taken than saying them; never negative. */
export function timeSavedMs(totalWords: number, totalSpeechMs: number): number {
  return Math.max(0, (totalWords / TYPING_WPM) * 60_000 - totalSpeechMs)
}

/** `48 s`, `12 min`, `1.5 h`: the short duration the apps print for time saved. */
export function formatDurationShort(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

/** `15 Aug 2026`, stable across server and client (fixed locale and UTC). */
export function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

/** Calendar month (UTC) as `YYYY-MM`, the key the backend files usage under. */
export function usagePeriod(now: number): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** `2026-09` as `September 2026`. */
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (!match) return period
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = now - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  return formatDate(new Date(ts).toISOString())
}
