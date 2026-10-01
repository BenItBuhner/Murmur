import type { InferenceView } from '@renderer/hooks/useInference'
import type { PlanState } from '@shared/cloud'
import {
  formatAudioSeconds,
  formatResetTime,
  isMetered,
  meterValue,
  planStateLabel,
  transcriptionPaused
} from '@shared/limits'

/**
 * The sentences the settings pages say about the account's plan, pure so they are tested as text.
 * Two things shape every one of them: whether the instance sells Pro (`billingEnabled`; off, no
 * plan is named, no trial counted, no upgrade suggested) and the private-testing states (`testing`,
 * `unlimited`), which are about the server rather than a plan and always show.
 */

/** "Pro trial", "Free plan", "Pro plan"; "Private testing", "Unlimited": the plan as a title. */
export function planTitle(state: PlanState): string {
  if (state === 'trial' || !isMetered(state)) return planStateLabel(state)
  return `${planStateLabel(state)} plan`
}

type PlanFacts = Pick<InferenceView, 'planState' | 'billingEnabled' | 'metered' | 'status'>

/**
 * Until the account status arrives neither the plan nor whether the instance sells one is known,
 * so the pages say "Murmur models" and that the account is being checked rather than guess at a
 * plan (the web account page does the same).
 */
export function planLoading(inference: Pick<InferenceView, 'status'>): boolean {
  return !inference.status
}

/**
 * Whether a plan label may be shown: a plan label is a billing thing, the private-testing states
 * are about the server, so they show; nothing is labelled before the status says which it is.
 */
export function planLabelled(inference: PlanFacts): boolean {
  return !planLoading(inference) && (inference.billingEnabled || !inference.metered)
}

/**
 * How the Murmur source is captioned where a plan would be named: "Murmur models" until the status
 * arrives, then the plan while the instance sells Pro, the private-testing state when there is
 * one, otherwise nothing plan-shaped.
 */
export function sourceCaption(inference: PlanFacts): string {
  if (planLoading(inference)) return 'Murmur models'
  if (!inference.metered) return planTitle(inference.planState)
  return inference.billingEnabled ? planTitle(inference.planState) : 'Included with your account'
}

/** The heading of the plan section: "Plan" while the instance is known to sell one, "Murmur models" otherwise. */
export function planSectionTitle(inference: PlanFacts): string {
  return !planLoading(inference) && inference.billingEnabled ? 'Plan' : 'Murmur models'
}

/**
 * What the plan means for the account right now, in one sentence. Without a way to buy Pro
 * (`billingEnabled` off) the sentence never sells one; during private testing it says whether the
 * models are open to this account.
 */
export function planDescription(inference: InferenceView): string {
  if (!inference.managedAvailable)
    return 'This Murmur instance does not provide models of its own; connect your provider under Speech model.'
  if (!inference.status) return 'Checking your account…'
  const selling = inference.billingEnabled
  const stopped = transcriptionPaused(inference.meters)
  switch (inference.planState) {
    case 'testing':
      return 'This Murmur server is in private testing: its speech and formatting models are not open to this account yet. Connect your own provider under Speech model to dictate meanwhile; your dictionary, snippets, style and stats keep syncing.'
    case 'unlimited':
      return "This account is on the server's list: Murmur's speech and formatting models without an allowance to run out of."
    case 'trial':
      return selling
        ? `${inference.trialDaysLeft === 1 ? '1 day' : `${inference.trialDaysLeft} days`} left with everything Pro offers, no card needed. Afterwards the free plan carries on with a weekly allowance; upgrade whenever you want to keep dictating without one.`
        : 'Unlimited dictation within fair use: the meters below show how far this month has come.'
    case 'pro':
      if (stopped)
        return `Unlimited dictation within fair use. This month's ${formatAudioSeconds(stopped.allowed)} are used up, so Murmur's speech model rests until ${formatResetTime(stopped.resetsAt).replace(/^on /, '')}; your own provider under Speech model keeps dictating meanwhile.`
      if (inference.formattingPaused)
        return 'Unlimited dictation within fair use. The formatting model is paused for the rest of this month; your text is still transcribed and tidied by rules.'
      return selling
        ? 'Unlimited dictation within fair use: the meters below show how far this month has come. Invoices, the card and cancellation live on your account page.'
        : 'Unlimited dictation within fair use: the meters below show how far this month has come.'
    default:
      return selling
        ? 'A weekly allowance of free words and speech, a handful of dictations a day, clips up to a minute. Upgrade for unlimited dictation, or connect your own provider under Speech model.'
        : 'A weekly allowance of words and speech, a handful of dictations a day, clips up to a minute. Connect your own provider under Speech model to dictate without them.'
  }
}

/**
 * Where the account stands, in one quiet line under the greeting: the trial's days, the free week's
 * words, a paused formatting model, or that the server is in private testing. Nothing when there
 * is nothing to say; never a banner. Without a way to buy Pro the line names no plan and counts no
 * trial days.
 */
export function planLine(inference: InferenceView): string | null {
  if (!inference.offersMurmur || !inference.signedIn || !inference.status) return null
  const selling = inference.billingEnabled
  if (inference.planState === 'testing')
    return inference.routing.stt === 'murmur'
      ? "Murmur's models are in private testing · connect your own under Speech model"
      : null
  if (inference.planState === 'unlimited') return null
  if (inference.routing.stt !== 'murmur' && inference.planState !== 'trial') return null
  const plan = (label: string): string => (selling ? `${label} · ` : '')
  if (inference.planState === 'trial') {
    if (!selling) return null
    const days = inference.trialDaysLeft
    return `Pro trial · ${days === 1 ? 'last day' : `${days} days left`}`
  }
  if (inference.planState === 'free') {
    const words = inference.meters.find((m) => m.limit === 'wordsPerWeek')
    const stopped = transcriptionPaused(inference.meters)
    if (stopped)
      return `${plan('Free plan')}this month's transcription is used up · more ${formatResetTime(stopped.resetsAt)}`
    if (words)
      return words.exceeded
        ? `${plan('Free plan')}this week's words are used up · more ${formatResetTime(words.resetsAt)}`
        : `${plan('Free plan')}${meterValue(words)} this week`
    return null
  }
  const stopped = transcriptionPaused(inference.meters)
  if (stopped)
    return `${plan('Pro')}transcription paused until ${formatResetTime(stopped.resetsAt).replace(/^on /, '')} (fair use)`
  if (inference.formattingPaused) {
    const paused = inference.meters.find((m) => m.limit === 'fairUseSttSecondsPerMonth')
    return `${plan('Pro')}formatting paused${paused ? ` until ${formatResetTime(paused.resetsAt).replace(/^on /, '')}` : ''} (fair use)`
  }
  return null
}
