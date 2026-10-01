import type { Env, InferenceKind } from './inference'

/**
 * How the gateway talks to a provider when the provider is slow or down. Pure, apart from
 * `callUpstream`, which takes the `fetch` to use so the policy can be exercised without a network.
 *
 * A Convex HTTP action may run for 30 minutes, so without a budget of its own the gateway waits as
 * long as the provider does and the user's client is what finally gives up (45 s on both apps by
 * default). The budgets below end a hung request well inside that, the retry covers the one case
 * where a second attempt is likely to help (a proxy that reset the connection or answered an empty
 * 502/503 at once), and the breaker spares every following request the same wait for a while.
 */

// ---- budgets ---------------------------------------------------------------------------------

export interface SttBudget {
  /** Allowance for a clip of any length. */
  baseMs: number
  /** Added per second of audio in the clip. */
  perAudioSecondMs: number
  /** Ceiling for the longest clips. */
  maxMs: number
  /** `MURMUR_INFERENCE_STT_TIMEOUT_MS`: one fixed budget for every clip, replacing the formula. */
  fixedMs: number | null
}

export interface UpstreamBudgets {
  stt: SttBudget
  /** One model round trip on `/v1/format` (the engine may make two). */
  formatMs: number
  /** One completion on `/v1/chat/completions` (command-mode edits, up to `MAX_COMPLETION_TOKENS`). */
  chatMs: number
}

/**
 * Defaults, from what healthy providers were measured to need:
 *
 * - Speech: production logs on 2026-10-01 showed healthy transcriptions answered in 1.5–4.3 s;
 *   the 15 s base is more than three times the slowest of them, and 0.5 s per second of audio
 *   keeps providers that run at only twice real time inside the budget on long clips. The 35 s
 *   ceiling stays under the apps' default 45 s request timeout, so the server, not the client,
 *   is what ends a hung request and the user hears why.
 * - Formatting: both apps give a formatting model 8 s before the rule-based text wins
 *   (`formatting.llm.timeoutMs`); the engine's two round trips at 8 s each fit the apps' 18 s
 *   allowance for `/v1/format`.
 * - Chat completions: command-mode edits return up to `MAX_COMPLETION_TOKENS` (4096) tokens,
 *   several times a formatting answer, and the apps let this timeout be raised to 60 s.
 */
export const DEFAULT_BUDGETS: UpstreamBudgets = {
  stt: { baseMs: 15_000, perAudioSecondMs: 500, maxMs: 35_000, fixedMs: null },
  formatMs: 8_000,
  chatMs: 20_000
}

function readMs(value: string | undefined): number | null {
  const n = Number((value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Budgets for this deployment: the defaults, or the operator's own figures in milliseconds
 * (`MURMUR_INFERENCE_STT_TIMEOUT_MS`, `MURMUR_INFERENCE_LLM_TIMEOUT_MS`,
 * `MURMUR_INFERENCE_CHAT_TIMEOUT_MS`). Anything that is not a positive integer is ignored.
 */
export function readUpstreamBudgets(env: Env): UpstreamBudgets {
  return {
    stt: { ...DEFAULT_BUDGETS.stt, fixedMs: readMs(env.MURMUR_INFERENCE_STT_TIMEOUT_MS) },
    formatMs: readMs(env.MURMUR_INFERENCE_LLM_TIMEOUT_MS) ?? DEFAULT_BUDGETS.formatMs,
    chatMs: readMs(env.MURMUR_INFERENCE_CHAT_TIMEOUT_MS) ?? DEFAULT_BUDGETS.chatMs
  }
}

/** The time one transcription of `clipSeconds` of audio gets. */
export function sttBudgetMs(budget: SttBudget, clipSeconds: number): number {
  if (budget.fixedMs !== null) return budget.fixedMs
  const seconds = Number.isFinite(clipSeconds) ? Math.max(0, clipSeconds) : 0
  return Math.min(budget.maxMs, Math.round(budget.baseMs + seconds * budget.perAudioSecondMs))
}

// ---- one call, with a deadline and one safe retry ---------------------------------------------

/** A failure the retry was quick enough to be worth it: the whole attempt took no longer than this. */
export const QUICK_FAILURE_MS = 2_000
/** Pause before the second attempt, so a proxy that just dropped a connection has a moment. */
export const RETRY_PAUSE_MS = 300
/** The second attempt is only made with at least this much of the budget left after the pause. */
export const RETRY_MIN_REMAINING_MS = 1_000

/** Why a provider could not be used; the gateway reports all of these as `provider_unavailable`. */
export type UnavailableReason = 'timeout' | 'unreachable' | 'unavailable'

export type UpstreamOutcome =
  | { kind: 'response'; res: Response; text: string; attempts: number; elapsedMs: number }
  /** The budget ran out before the provider answered. */
  | { kind: 'timeout'; attempts: number; elapsedMs: number }
  /** `fetch` itself failed: DNS, a refused or reset connection, a TLS fault. */
  | { kind: 'unreachable'; detail: string; attempts: number; elapsedMs: number }

type Attempt =
  | { kind: 'response'; res: Response; text: string }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; detail: string }

/**
 * Whether a failed attempt is worth one more try. Only when the request can be assumed not to
 * have reached the model: the connection failed outright, or a proxy answered 502/503 with
 * nothing in the body (what a load balancer says when it has no healthy upstream). A 5xx with a
 * body, a 429 and every 4xx are answers from the provider and are reported as they are.
 */
export function retryWorthwhile(attempt: { kind: string; res?: Response; text?: string }): boolean {
  if (attempt.kind === 'unreachable') return true
  if (attempt.kind !== 'response' || !attempt.res) return false
  return (attempt.res.status === 502 || attempt.res.status === 503) && (attempt.text ?? '').trim() === ''
}

/** A retry has to be quick and has to fit: the budget is never extended for it. */
export function retryFits(elapsedMs: number, remainingMs: number): boolean {
  return elapsedMs <= QUICK_FAILURE_MS && remainingMs >= RETRY_PAUSE_MS + RETRY_MIN_REMAINING_MS
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve with the body, or reject the moment `signal` aborts, whichever comes first. */
function readWithin(res: Response, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    res.text().then(
      (text) => {
        signal.removeEventListener('abort', onAbort)
        resolve(text)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/**
 * One provider call within `budgetMs`, body read included, with at most one more attempt when the
 * first failed in a way a retry can help with (`retryWorthwhile`) quickly enough to leave room for
 * it (`retryFits`). `init` is called per attempt so each gets a fresh body. The abort reaches the
 * runtime's fetch, so a hung connection is actually dropped, not merely given up on.
 */
export async function callUpstream(
  url: string,
  init: () => RequestInit,
  budgetMs: number,
  fetchFn: typeof fetch = fetch
): Promise<UpstreamOutcome> {
  const started = Date.now()
  const deadline = started + Math.max(1, budgetMs)

  const attempt = async (): Promise<Attempt> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { kind: 'timeout' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      const res = await fetchFn(url, { ...init(), signal: controller.signal })
      const text = await readWithin(res, controller.signal)
      return { kind: 'response', res, text }
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'timeout' }
      return { kind: 'unreachable', detail: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  let attempts = 1
  let result = await attempt()
  const elapsed = Date.now() - started
  if (retryWorthwhile(result) && retryFits(elapsed, deadline - Date.now())) {
    await sleep(RETRY_PAUSE_MS)
    attempts = 2
    result = await attempt()
  }
  return { ...result, attempts, elapsedMs: Date.now() - started }
}

// ---- circuit breaker --------------------------------------------------------------------------

/**
 * After this many consecutive unavailable answers from a provider the gateway stops asking it for
 * `BREAKER_COOLDOWN_MS` and answers `provider_unavailable` at once, so a user does not wait out the
 * budget on every dictation while the provider is down. The state is one row per provider in the
 * database (`providerHealth`), read in the same mutation that gates every request, so it costs no
 * extra round trip; HTTP actions themselves keep nothing between requests.
 */
export const BREAKER_THRESHOLD = 3
export const BREAKER_COOLDOWN_MS = 15_000

export interface BreakerState {
  /** Consecutive unavailable answers; a successful one resets it. */
  failures: number
  /** While set and in the future, the provider is not asked. */
  openUntil: number | null
}

/** Milliseconds the breaker stays open from `now`, or null when requests may go through. */
export function breakerOpenFor(state: BreakerState, now: number): number | null {
  if (state.openUntil === null || state.openUntil <= now) return null
  return state.openUntil - now
}

/** The state after one more unavailable answer at `now`. */
export function breakerAfterFailure(state: BreakerState, now: number): BreakerState {
  const failures = state.failures + 1
  return {
    failures,
    openUntil: failures >= BREAKER_THRESHOLD ? now + BREAKER_COOLDOWN_MS : null
  }
}

/** Seconds a client should wait before asking again, never less than one. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

/** How a provider is named to users: the service it provides, not the vendor behind it. */
export function serviceOf(kind: InferenceKind): 'speech' | 'formatting' {
  return kind === 'stt' ? 'speech' : 'formatting'
}
