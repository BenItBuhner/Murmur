const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function requireDay(day: string): string {
  if (!DAY_RE.test(day)) throw new Error('day must be formatted YYYY-MM-DD')
  return day
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** Streak rule shared with the desktop app: consecutive local days with at least one session. */
export function nextStreak(
  previous: { streakDays: number; lastSessionDay: string },
  day: string
): number {
  if (!previous.lastSessionDay) return 1
  const gap = daysBetween(previous.lastSessionDay, day)
  if (gap === 0) return Math.max(1, previous.streakDays)
  if (gap === 1) return previous.streakDays + 1
  // Devices in different time zones can report a day the account has already moved past.
  if (gap < 0) return Math.max(1, previous.streakDays)
  return 1
}
