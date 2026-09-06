import type { InstallKind } from './updates'

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

/**
 * What happened in the smart-formatting stage, so the History view can explain the result.
 *   used      the model's text was inserted as returned (after cleanup)
 *   partial   the model's text was inserted, but some edits were reverted to the spoken words
 *   rejected  the model's answer failed the guard rails; the rule-based text was inserted
 *   failed    the request errored or timed out; the rule-based text was inserted
 *   skipped   the model was not asked (mode, too short, no model configured, snippet expanded)
 */
export type LlmOutcome = 'used' | 'partial' | 'rejected' | 'failed' | 'skipped'

export interface LlmStatus {
  outcome: LlmOutcome
  /** Guard reason, error message, or why it was skipped. */
  detail?: string
  /** Edits accepted / reverted by the review (used and partial outcomes). */
  accepted?: number
  reverted?: number
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
  llm?: LlmStatus
  /** Rule-based stages that changed the text, in order. */
  stages?: string[]
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
  /** How this copy was installed; decides which release file updates use. */
  installKind: InstallKind
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

/** Settings playground: run a transcript through the pipeline as if dictated into a given app. */
export interface PreviewRequest {
  raw: string
  /** Process/app name to classify (e.g. "slack", "Code.exe"); blank means an unknown text field. */
  app?: string
  title?: string
  /** Also ask the smart-formatting model (when configured and applicable). */
  smart?: boolean
}

export interface PreviewResult {
  light: {
    text: string
    stages: string[]
    wordCount: number
    pressEnter: boolean
    listRequested: 'bullets' | 'numbers' | 'any' | null
    listApplied: boolean
    isQuestion: boolean
  }
  style: {
    category: string
    ruleMatch?: string
    tone: string
    mode: string
    lists: string
    numbers: string
    freedom: string
    structure: string
  }
  smart?: {
    status: LlmStatus
    /** Final text after the review and the finishing pass. */
    text?: string
    /** Cleaned model output before the review. */
    modelText?: string
    llmMs: number
    review?: Array<{ accept: boolean; why: string; from: string; to: string }>
  }
}
