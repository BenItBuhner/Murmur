import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

/** Ephemeris Enterprise retention: meetings and notes older than the workspace allows are deleted everywhere. */
crons.daily('ephemeris retention', { hourUTC: 4, minuteUTC: 17 }, internal.ephemeris.retention.sweep, {})

/**
 * All-day timeline audio is a week-long cache. Desktops delete what they have taken; this catches
 * the rows no desktop asked about, so the wavs cannot sit in file storage past the keep window.
 */
crons.daily('timeline audio expiry', { hourUTC: 5, minuteUTC: 11 }, internal.timeline.sweepExpired, {})

export default crons
