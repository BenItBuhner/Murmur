import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { parseSettings, type Settings } from '@shared/settings'
import { createLogger } from '../logger'
import { JsonStore } from './json-store'

const log = createLogger('settings')

export type SecretSlot = 'stt' | 'llm'

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? T[K] extends Array<unknown>
      ? T[K]
      : DeepPartial<T[K]>
    : T[K]
}
export type SettingsPatch = DeepPartial<Settings>

/**
 * Who made a change. `cloud` marks writes performed by the sync engine when it mirrors account
 * data, so the engine does not echo them back to the server.
 */
export type SettingsOrigin = 'local' | 'cloud'

function deepMerge<T>(base: T, patch: unknown): T {
  if (Array.isArray(patch)) return patch as T
  if (
    patch &&
    typeof patch === 'object' &&
    base &&
    typeof base === 'object' &&
    !Array.isArray(base)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v)
    }
    return out as T
  }
  return (patch === undefined ? base : patch) as T
}

/** Encrypt with the OS keychain-backed key when available; otherwise mark as plain so we never lie about it. */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plain).toString('base64')}`
    }
  } catch (err) {
    log.warn('safeStorage unavailable, storing secret unencrypted', err)
  }
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

export function decryptSecret(stored: string): string {
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    } catch (err) {
      log.error('Could not decrypt stored secret (keychain changed?)', err)
      return ''
    }
  }
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
  return stored
}

export class SettingsStore extends EventEmitter {
  private store: JsonStore<Settings>

  constructor(userDataPath: string) {
    super()
    this.store = new JsonStore<Settings>(join(userDataPath, 'settings.json'), parseSettings)
    const s = this.store.get()
    if (!s.stt.baseUrl && process.env.MURMUR_BASE_URL) {
      // Developer convenience: seed provider settings from the environment on first run. A seeded
      // provider is meant to be used, so the models come from it rather than from the instance.
      this.patch({
        stt: {
          source: 'custom',
          baseUrl: process.env.MURMUR_BASE_URL,
          model: process.env.MURMUR_STT_MODEL ?? s.stt.model,
          apiKeyEnc: process.env.MURMUR_API_KEY
            ? encryptSecret(process.env.MURMUR_API_KEY)
            : s.stt.apiKeyEnc
        },
        formatting: {
          llm: { source: 'custom', model: process.env.MURMUR_LLM_MODEL ?? s.formatting.llm.model }
        }
      })
    }
  }

  get(): Settings {
    return this.store.get()
  }

  patch(patch: SettingsPatch, origin: SettingsOrigin = 'local'): Settings {
    const merged = deepMerge(this.store.get(), patch)
    const next = parseSettings(merged)
    this.store.set(next)
    this.emit('change', next, patch, origin)
    return next
  }

  replace(next: Settings, origin: SettingsOrigin = 'local'): Settings {
    const parsed = parseSettings(next)
    this.store.set(parsed)
    this.emit('change', parsed, {}, origin)
    return parsed
  }

  /** Back to defaults, keeping the device identity and the account relationship intact. */
  reset(): Settings {
    const current = this.get()
    return this.replace(parseSettings({ onboardingComplete: true, cloud: current.cloud }))
  }

  setSecret(slot: SecretSlot, plain: string): void {
    const enc = encryptSecret(plain)
    if (slot === 'stt') this.patch({ stt: { apiKeyEnc: enc } })
    else this.patch({ formatting: { llm: { apiKeyEnc: enc } } })
  }

  getSecret(slot: SecretSlot): string {
    const s = this.get()
    return decryptSecret(slot === 'stt' ? s.stt.apiKeyEnc : s.formatting.llm.apiKeyEnc)
  }

  hasSecret(slot: SecretSlot): boolean {
    const s = this.get()
    return !!(slot === 'stt' ? s.stt.apiKeyEnc : s.formatting.llm.apiKeyEnc)
  }

  /** Effective LLM connection, honouring "same as STT". */
  llmConnection(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number } {
    const s = this.get()
    const llm = s.formatting.llm
    if (llm.sameAsStt) {
      return {
        baseUrl: s.stt.baseUrl,
        apiKey: this.getSecret('stt'),
        model: llm.model,
        timeoutMs: llm.timeoutMs
      }
    }
    return {
      baseUrl: llm.baseUrl,
      apiKey: this.getSecret('llm'),
      model: llm.model,
      timeoutMs: llm.timeoutMs
    }
  }

  flush(): void {
    this.store.flush()
  }
}
