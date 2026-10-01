import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatDate,
  formatDurationShort,
  formatPeriod,
  formatRelative,
  timeSavedMs,
  usagePeriod,
  wordsPerMinute
} from './format'

describe('formatBytes', () => {
  it('uses decimal units with one decimal under ten', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2435)).toBe('2.4 KB')
    expect(formatBytes(36_465_490)).toBe('36 MB')
    expect(formatBytes(216_745_251)).toBe('217 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('dates and periods', () => {
  it('formats release dates in UTC', () => {
    expect(formatDate('2026-09-06T20:16:15Z')).toBe('6 Sept 2026')
    expect(formatDate('not a date')).toBe('')
  })
  it('keys usage by UTC month like the backend', () => {
    expect(usagePeriod(Date.UTC(2026, 8, 11, 9, 57))).toBe('2026-09')
    expect(usagePeriod(Date.UTC(2026, 0, 1, 0, 0))).toBe('2026-01')
    expect(formatPeriod('2026-09')).toBe('September 2026')
    expect(formatPeriod('')).toBe('')
  })
  it('describes recent timestamps relatively', () => {
    const now = Date.UTC(2026, 8, 11, 12, 0)
    expect(formatRelative(now - 30_000, now)).toBe('just now')
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 d ago')
  })
})

describe('the account stats, the same figures the apps show on Home', () => {
  it('derives pace and time saved from the account totals', () => {
    // 1200 words in 10 minutes of speech: 120 wpm, against 30 minutes of typing at 40 wpm.
    expect(wordsPerMinute(1200, 10 * 60_000)).toBe(120)
    expect(timeSavedMs(1200, 10 * 60_000)).toBe(20 * 60_000)
    // Nothing said yet, or slower than typing: no pace, nothing saved, never a negative.
    expect(wordsPerMinute(0, 0)).toBe(0)
    expect(timeSavedMs(10, 60_000)).toBe(0)
  })
  it('prints durations the way the apps do', () => {
    expect(formatDurationShort(48_000)).toBe('48 s')
    expect(formatDurationShort(12 * 60_000)).toBe('12 min')
    expect(formatDurationShort(1.5 * 3_600_000)).toBe('1.5 h')
  })
})
