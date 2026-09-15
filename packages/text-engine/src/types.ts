/**
 * Shared vocabulary of the text engine. Nothing here depends on a platform: the same types are
 * used by the Electron main process, the Convex gateway and (mirrored) by the Android app.
 */

export type AppCategory =
  'chat' | 'email' | 'document' | 'code' | 'terminal' | 'browser' | 'notes' | 'unknown'

export type Tone = 'auto' | 'casual' | 'neutral' | 'professional'
export type ResolvedTone = Exclude<Tone, 'auto'>

/** `off`: insert the transcript as heard. `light`: rule-based tidying only. `smart`: the model. */
export type FormattingMode = 'off' | 'light' | 'smart'

export interface DictionaryTerm {
  word: string
  aliases: readonly string[]
  /** Correct near-misses by spelling or sound even when the transcript token is lower-case. */
  fuzzy?: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  text: string
  finishReason?: string
  model?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
}

/** One chat completion. Injected so the engine never knows about HTTP, tokens or timeouts. */
export type Complete = (messages: ChatMessage[], opts: ChatOptions) => Promise<ChatResult>

/**
 * Everything the model is told about one dictation besides the transcript. Built by the caller
 * from the active window, the user's settings and the account's dictionary.
 */
export interface FormatContext {
  category: AppCategory
  /** Process or package name, for the destination line ("a chat message (Slack)"). */
  app?: string
  tone: ResolvedTone
  /** 'auto' or an ISO-639-1 code. */
  language?: string
  /** Text immediately before the cursor, when the platform can read it. */
  precedingText?: string
  /** Free-form guidance from the user and the matching per-app rule, already merged. */
  instructions?: string
  dictionary: readonly DictionaryTerm[]
  /** Phrases that must survive verbatim (snippet triggers, for example). */
  keepVerbatim?: readonly string[]
}

export type FormatOutcome = 'used' | 'skipped' | 'rejected' | 'failed'

export interface FormatStatus {
  outcome: FormatOutcome
  /** Why it was skipped or rejected, or the error message. */
  detail?: string
  /** Model round trips made (0 when skipped). */
  attempts: number
  /** The verifier's reason for the first rejected attempt, when a retry was needed. */
  retriedAfter?: string
}

export interface FormatResult {
  /** The text to insert (before client-side finishing such as snippets and trailing space). */
  text: string
  pressEnter: boolean
  status: FormatStatus
  /** Cleaned model output of the last attempt, for History and the settings playground. */
  modelText?: string
  llmMs: number
  /** Names of the stages that changed the text, in order. */
  stages: string[]
}
