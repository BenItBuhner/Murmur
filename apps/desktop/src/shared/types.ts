export type DictationMode = 'hold' | 'hands-free' | 'command'

export type OverlayPhase = 'idle' | 'listening' | 'processing' | 'success' | 'error' | 'disabled'

export interface OverlayState {
  phase: OverlayPhase
  mode?: DictationMode
  message?: string
  /** Seconds elapsed while listening. */
  elapsedSec?: number
  /** Visible when the user has an active hands-free lock. */
  locked?: boolean
}

export interface StageTimings {
  /** Speech duration captured, before trimming. */
  recordMs: number
  vadMs: number
  sttMs: number
  formatMs: number
  llmMs: number
  injectMs: number
  /** Hotkey release/stop -> text inserted. */
  totalMs: number
}

export interface HistoryEntry {
  id: string
  createdAt: number
  mode: DictationMode
  rawText: string
  finalText: string
  wordCount: number
  speechMs: number
  appName?: string
  provider: string
  model: string
  injected: boolean
  injectionMethod?: string
  llmUsed: boolean
  timings: StageTimings
  error?: string
  /** Set on entries that arrived through account history sync from another device. */
  deviceId?: string
  deviceName?: string
  remote?: boolean
}

export interface SttModelInfo {
  id: string
  ownedBy?: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  text?: string
  latencyMs?: number
  suggestedModels?: string[]
}

export interface HotkeyCapture {
  keys: number[]
  label: string
  valid: boolean
  reason?: string
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  arch: string
  electron: string
  hookBackend: 'uiohook' | 'globalShortcut' | 'none'
  injectionBackend: string
  sessionType?: string
  userDataPath: string
  logPath: string
}

export interface ActiveWindowInfo {
  title: string
  app: string
  pid?: number
}

export interface DictationEvent {
  state: OverlayState
  lastEntry?: HistoryEntry
}
