import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

/** Ephemeris Enterprise retention: meetings and notes older than the workspace allows are deleted everywhere. */
crons.daily('ephemeris retention', { hourUTC: 4, minuteUTC: 17 }, internal.ephemeris.retention.sweep, {})

export default crons
