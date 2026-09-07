import { useMemo } from 'react'
import { currentUsagePeriod, type InferenceStatus, type Plan } from '@shared/cloud'
import {
  llmConfigured,
  resolveInferenceSources,
  sttConfigured,
  type InferenceRouting
} from '@shared/inference'
import { useCloud } from './useCloud'
import { useSettings } from './useSettings'

export interface InferenceView {
  /** This build talks to a cloud instance, so Murmur models are a possible choice at all. */
  cloudEnabled: boolean
  /** The instance offers managed models (true until the account status says otherwise). */
  managedAvailable: boolean
  /** Murmur models can be offered in the UI: cloud build with a configured instance. */
  offersMurmur: boolean
  routing: InferenceRouting
  signedIn: boolean
  status: InferenceStatus | null
  plan: Plan
  /** Speech / formatting are ready to use for the resolved sources. */
  sttReady: boolean
  llmReady: boolean
  /** Managed speech minutes used and allowed this month. */
  minutes: { used: number; limit: number } | null
  /** Managed formatting tokens used this month. */
  tokensUsed: number
}

/** The resolved view of where speech and formatting run, shared by every settings page. */
export function useInference(): InferenceView {
  const { settings } = useSettings()
  const cloud = useCloud()
  const status = cloud.status?.inference ?? null
  const signedIn = cloud.enabled && cloud.clerk.signedIn
  return useMemo(() => {
    const cloudEnabled = cloud.enabled && !!cloud.config?.convexSiteUrl
    const managedAvailable = status?.available ?? true
    const routing = resolveInferenceSources(settings, { cloudEnabled, managedAvailable })
    const period = currentUsagePeriod()
    const thisMonth = status && status.usage.period === period ? status.usage : null
    const usedSeconds = thisMonth?.sttSeconds ?? 0
    return {
      cloudEnabled,
      managedAvailable,
      offersMurmur: cloudEnabled && managedAvailable,
      routing,
      signedIn,
      status,
      plan: status?.plan ?? cloud.status?.user?.plan ?? 'free',
      sttReady: sttConfigured(settings, routing, signedIn),
      llmReady: llmConfigured(settings, routing, signedIn),
      minutes: status
        ? { used: usedSeconds / 60, limit: status.limits.sttSecondsPerMonth / 60 }
        : null,
      tokensUsed: thisMonth?.llmTokens ?? 0
    }
  }, [
    settings,
    cloud.enabled,
    cloud.config?.convexSiteUrl,
    cloud.status?.user?.plan,
    status,
    signedIn
  ])
}

export function planLabel(plan: Plan): string {
  return plan === 'pro' ? 'Pro' : 'Free'
}

/** "12 of 120 min" style summary of the month's managed transcription. */
export function minutesLabel(minutes: { used: number; limit: number }): string {
  const used = minutes.used < 1 && minutes.used > 0 ? '<1' : Math.round(minutes.used).toString()
  return `${used} of ${Math.round(minutes.limit)} min this month`
}
