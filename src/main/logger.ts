import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let logDir = ''
let logFile = ''
let minLevel: Level = 'info'
const MAX_BYTES = 2 * 1024 * 1024

export function initLogger(dir: string, level: Level = 'info'): string {
  logDir = dir
  logFile = join(dir, 'murmur.log')
  minLevel = level
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return logFile
}

export function setLogLevel(level: Level): void { minLevel = level }
export function getLogPath(): string { return logFile }

function rotateIfNeeded(): void {
  try { if (logFile && existsSync(logFile) && statSync(logFile).size > MAX_BYTES) renameSync(logFile, join(logDir, 'murmur.old.log')) } catch {}
}

function write(level: Level, scope: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const ts = new Date().toISOString()
  const text = args.map((a) => { if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`; if (typeof a === 'string') return a; try { return JSON.stringify(a) } catch { return String(a) } }).join(' ')
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(line)
  if (logFile) { try { rotateIfNeeded(); appendFileSync(logFile, `${line}\n`) } catch {} }
}

export interface Logger { debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
export function createLogger(scope: string): Logger { return { debug: (...a) => write('debug', scope, a), info: (...a) => write('info', scope, a), warn: (...a) => write('warn', scope, a), error: (...a) => write('error', scope, a) } }
