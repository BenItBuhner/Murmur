/**
 * Live integration test for the cloud sync engine against a real Convex deployment.
 *
 * It mints RS256 JWTs itself, so the target deployment must trust the test issuer through a
 * `customJwt` provider in convex/auth.config.ts whose JWKS contains the public key of
 * MURMUR_TEST_JWT_KEY (a PEM private key). Example (see scripts in the PR description):
 *
 *   MURMUR_LIVE=1 MURMUR_CONVEX_URL=http://127.0.0.1:3210 \
 *   MURMUR_TEST_JWT_ISSUER=https://murmur-test.local MURMUR_TEST_JWT_KEY=/tmp/key.pem \
 *   npm run test:live -- tests/live/cloud-sync.test.ts
 *
 * Excluded from the default `npm test` run.
 */
import { createPrivateKey, createSign, randomUUID, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConvexClient } from 'convex/browser'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudConfig } from '@shared/cloud'
import type { HistoryEntry } from '@shared/types'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false }
}))

const convexUrl = process.env.MURMUR_CONVEX_URL ?? ''
const issuer = process.env.MURMUR_TEST_JWT_ISSUER ?? ''
const keyFile = process.env.MURMUR_TEST_JWT_KEY ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!convexUrl && !!issuer && !!keyFile

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function mintJwt(key: KeyObject, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'murmur-test' }))
  const payload = b64url(
    JSON.stringify({
      iss: issuer,
      aud: 'convex',
      iat: now,
      nbf: now - 5,
      exp: now + 3600,
      ...claims
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(key))}`
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const entry = (id: string, words: number): HistoryEntry => ({
  id,
  createdAt: Date.now(),
  mode: 'hold',
  rawText: 'um hello there',
  finalText: 'Hello there.',
  wordCount: words,
  speechMs: 1200,
  appName: 'Test',
  provider: 'openai-compatible',
  model: 'whisper-1',
  injected: true,
  llmUsed: false,
  timings: { recordMs: 1200, vadMs: 1, sttMs: 2, formatMs: 3, llmMs: 0, injectMs: 4, totalMs: 10 }
})

describe.skipIf(!enabled)('cloud sync engine (live)', () => {
  const userId = `user_e2e_${randomUUID().slice(0, 8)}`
  let key: KeyObject
  let dir: string
  let engine: import('../../src/main/cloud/sync-engine').CloudSync
  let settings: import('../../src/main/store/settings').SettingsStore
  let history: import('../../src/main/store/history').HistoryStore
  let probe: ConvexClient
  let api: typeof import('../../src/main/cloud/api').api

  beforeAll(async () => {
    key = createPrivateKey(readFileSync(keyFile, 'utf8'))
    dir = mkdtempSync(join(tmpdir(), 'murmur-sync-'))
    const { SettingsStore } = await import('../../src/main/store/settings')
    const { HistoryStore } = await import('../../src/main/store/history')
    const { CloudSync } = await import('../../src/main/cloud/sync-engine')
    ;({ api } = await import('../../src/main/cloud/api'))

    settings = new SettingsStore(dir)
    history = new HistoryStore(dir)
    // Data that existed on the device before it had an account.
    settings.patch({
      onboardingComplete: true,
      dictionary: [
        {
          id: 'local-1',
          word: 'Wispr Flow',
          aliases: ['whisper flow'],
          fuzzy: true,
          createdAt: 1000
        }
      ],
      snippets: [
        { id: 'local-s1', trigger: 'my email', content: 'ada@example.com', createdAt: 1000 }
      ],
      stats: {
        totalWords: 40,
        totalSessions: 4,
        totalSpeechMs: 8000,
        streakDays: 2,
        lastSessionDay: '2026-09-04'
      }
    })

    const token = (): Promise<string | null> =>
      Promise.resolve(
        mintJwt(key, { sub: userId, email: `${userId}@example.com`, name: 'E2E Ada' })
      )
    const config: CloudConfig = {
      accountMode: 'required',
      convexUrl,
      clerkPublishableKey: 'pk_test_unused',
      clerkFrontendApiHost: 'unused.example',
      deepLinkScheme: 'murmur',
      jwtTemplate: 'convex'
    }
    engine = new CloudSync({
      config,
      settings,
      history,
      tokenBridge: { request: token },
      userDataPath: dir,
      appVersion: '0.0.0-test',
      platform: 'linux'
    })
    engine.start()

    probe = new ConvexClient(convexUrl, {
      webSocketConstructor: (globalThis as { WebSocket: typeof WebSocket }).WebSocket,
      skipConvexDeploymentUrlCheck: true,
      unsavedChangesWarning: false,
      logger: false
    })
    probe.setAuth(token)
  }, 30_000)

  afterAll(async () => {
    try {
      // Leave the shared deployment clean for the next run.
      await probe.mutation(api.users.deleteMyData, {})
    } catch {
      // the account may already be gone
    }
    engine?.dispose()
    await probe?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('authenticates, merges pre-account data and mirrors the account', async () => {
    engine.setAuthState({ signedIn: true, userId, email: `${userId}@example.com`, name: 'E2E Ada' })
    await waitFor(() => engine.getStatus().phase === 'synced', 'initial sync')
    const status = engine.getStatus()
    expect(status.authenticated).toBe(true)
    expect(status.user?.email).toBe(`${userId}@example.com`)
    expect(status.devices.some((d) => d.current)).toBe(true)

    const s = settings.get()
    expect(s.cloud.importedForUserId).toBe(userId)
    expect(s.cloud.lastSignedInUserId).toBe(userId)
    // The local word now lives under its Convex id.
    expect(s.dictionary.map((e) => e.word)).toEqual(['Wispr Flow'])
    expect(s.dictionary[0].id).not.toBe('local-1')
    expect(s.dictionary[0].aliases).toEqual(['whisper flow'])
    expect(s.snippets[0].id).not.toBe('local-s1')
    // Stats were folded into the account and are now served from it.
    expect(s.stats).toMatchObject({ totalWords: 40, totalSessions: 4 })

    const remote = await probe.query(api.dictionary.list, {})
    expect(remote.map((e) => e.word)).toEqual(['Wispr Flow'])
    const prefs = await probe.query(api.preferences.get, {})
    expect(prefs?.formatting?.mode).toBe('smart')
    const me = await probe.query(api.users.me, {})
    expect(me?.onboardingCompletedAt).toBeTypeOf('number')
  }, 40_000)

  it('pushes local edits through the outbox and pulls remote edits into the mirror', async () => {
    const s0 = settings.get()
    settings.patch({
      dictionary: [
        { id: 'tmp-convex', word: 'Convex', aliases: [], fuzzy: false, createdAt: Date.now() },
        ...s0.dictionary
      ]
    })
    await waitFor(
      () =>
        engine.getStatus().phase === 'synced' &&
        settings.get().dictionary.every((e) => !e.id.startsWith('tmp-')),
      'local add to be acknowledged'
    )
    let remote = await probe.query(api.dictionary.list, {})
    expect(remote.map((e) => e.word).sort()).toEqual(['Convex', 'Wispr Flow'])

    await probe.mutation(api.dictionary.upsert, { word: 'Clerk', aliases: ['clark'] })
    await waitFor(
      () => settings.get().dictionary.some((e) => e.word === 'Clerk'),
      'remote add to arrive'
    )
    expect(settings.get().dictionary.find((e) => e.word === 'Clerk')?.aliases).toEqual(['clark'])

    const wispr = settings.get().dictionary.find((e) => e.word === 'Wispr Flow')!
    settings.patch({ dictionary: settings.get().dictionary.filter((e) => e.id !== wispr.id) })
    await waitFor(() => engine.getStatus().phase === 'synced', 'removal to flush')
    remote = await probe.query(api.dictionary.list, {})
    expect(remote.map((e) => e.word).sort()).toEqual(['Clerk', 'Convex'])
    expect(
      settings
        .get()
        .dictionary.map((e) => e.word)
        .sort()
    ).toEqual(['Clerk', 'Convex'])
  }, 40_000)

  it('syncs style preferences and dictation stats', async () => {
    settings.patch({
      formatting: { tone: 'casual', fillerWords: ['um', 'uh'] },
      stt: { language: 'en' }
    })
    await waitFor(() => engine.getStatus().phase === 'synced', 'preferences to flush')
    const prefs = await probe.query(api.preferences.get, {})
    expect(prefs?.formatting?.tone).toBe('casual')
    expect(prefs?.formatting?.fillerWords).toEqual(['um', 'uh'])
    expect(prefs?.language).toBe('en')

    // Another device changes the tone.
    await probe.mutation(api.preferences.update, { formatting: { tone: 'professional' } })
    await waitFor(() => settings.get().formatting.tone === 'professional', 'remote tone to arrive')

    const before = settings.get().stats.totalSessions
    engine.recordSession(entry('session-1', 9))
    await waitFor(() => engine.getStatus().phase === 'synced', 'stats to flush')
    const stats = await probe.query(api.stats.get, {})
    expect(stats?.totalSessions).toBe(before + 1)
    expect(stats?.totalWords).toBe(49)
    expect(settings.get().stats.totalSessions).toBe(before + 1)
  }, 40_000)

  it('opts into history sync and pushes dictations', async () => {
    engine.setHistorySync(true)
    history.add(entry('hist-1', 2))
    await waitFor(
      () => engine.getStatus().phase === 'synced' && settings.get().cloud.historySync,
      'history push'
    )
    const recent = await probe.query(api.history.recent, {})
    expect(recent.map((e) => e.entryId)).toContain('hist-1')
    const prefs = await probe.query(api.preferences.get, {})
    expect(prefs?.sync?.history).toBe(true)
  }, 40_000)

  it('signing out wipes account data from the device', async () => {
    engine.setAuthState({ signedIn: false })
    await waitFor(() => engine.getStatus().phase === 'signed-out', 'sign-out')
    const s = settings.get()
    expect(s.dictionary).toEqual([])
    expect(s.snippets).toEqual([])
    expect(s.stats.totalSessions).toBe(0)
    expect(s.cloud.lastSignedInUserId).toBe('')
    expect(history.list().total).toBe(0)
    expect(engine.getStatus().pendingOps).toBe(0)
    // The account itself is untouched.
    const remote = await probe.query(api.dictionary.list, {})
    expect(remote.length).toBe(2)
  }, 20_000)
})
