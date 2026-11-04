/**
 * Phone as microphone, end to end (docs/phone-microphone.md): a headless Chromium plays the phone
 * (the website's PhoneMicLink, its microphone a speech clip), a second one plays the desktop's
 * overlay renderer (PhoneLinkHost and MicCapture, the code the app runs), and the main-process
 * PhoneMicHost runs here, all signaling through a real Convex deployment. It checks that the
 * phone's speech arrives in the desktop's capture as 16 kHz PCM over WebRTC, that start / stop /
 * results travel the data channel, that a hang-up ends the dictation with what was said, and that
 * no signaling rows are left behind.
 *
 * Needs a deployment that trusts a test JWT issuer (see tests/live/cloud-sync.test.ts) and the
 * pre-installed Playwright Chromium:
 *
 *   MURMUR_LIVE=1 MURMUR_CONVEX_URL=http://127.0.0.1:3210 \
 *   MURMUR_TEST_JWT_ISSUER=https://murmur-test.local MURMUR_TEST_JWT_KEY=/tmp/key.pem \
 *   npm run test:live -- tests/live/phone-mic.test.ts
 */
import { EventEmitter } from 'node:events'
import { createPrivateKey, createSign, randomUUID, type KeyObject } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConvexClient } from 'convex/browser'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PhoneMicStatus } from '@shared/ipc'
import { api } from '../../src/main/cloud/api'
import {
  PhoneMicHost,
  type CloudSource,
  type DictationSource,
  type SignalingClient
} from '../../src/main/phone-mic/host'

vi.mock('../../src/main/logger', () => ({
  createLogger: () => ({
    info: (m: string) => console.log(`[phone-mic] ${m}`),
    warn: (m: string) => console.warn(`[phone-mic] ${m}`),
    debug: () => {},
    error: (m: string) => console.error(`[phone-mic] ${m}`)
  })
}))

const convexUrl = process.env.MURMUR_CONVEX_URL ?? ''
const issuer = process.env.MURMUR_TEST_JWT_ISSUER ?? ''
const keyFile = process.env.MURMUR_TEST_JWT_KEY ?? ''
const enabled = !!process.env.MURMUR_LIVE && !!convexUrl && !!issuer && !!keyFile

const desktopRoot = resolve(__dirname, '../..')
const webRoot = resolve(desktopRoot, '../web')
const backendRoot = resolve(desktopRoot, '../../packages/backend/convex')
const speechClip = resolve(desktopRoot, 'resources/fixtures/jfk.wav')

function mintJwt(key: KeyObject, sub: string): string {
  const b64 = (v: string | Buffer): string => Buffer.from(v).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'murmur-test' }))
  const payload = b64(
    JSON.stringify({ iss: issuer, aud: 'convex', sub, iat: now, nbf: now - 5, exp: now + 3600 })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64(signer.sign(key))}`
}

async function waitFor<T>(check: () => T | undefined | false, what: string, ms = 20_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const DESKTOP_ENTRY = `
import { PhoneLinkHost } from '${desktopRoot}/src/renderer/src/overlay/phone-link'
import { MicCapture } from '${desktopRoot}/src/renderer/src/overlay/capture'
const toNode = (type, payload) => window.toNode(type, payload)
const session = { samples: 0, sumSq: 0, loud: 0 }
const capture = new MicCapture({
  onChunk: (_id, pcm) => {
    const s = new Int16Array(pcm)
    let sq = 0
    for (let i = 0; i < s.length; i++) sq += (s[i] / 32768) ** 2
    session.samples += s.length
    session.sumSq += sq
    if (Math.sqrt(sq / s.length) > 0.02) session.loud += s.length
  },
  onLevel: (l) => toNode('level', l),
  onStatus: (s) => toNode('status', s),
  onStopped: (id, n) => toNode('stopped', { id, n, samples: session.samples, rms: Math.sqrt(session.sumSq / Math.max(1, session.samples)), loud: session.loud })
})
void capture.configure({ deviceId: 'default', keepWarm: false, preBufferMs: 0, noiseSuppression: true, autoGainControl: true, soundVolume: 0 })
const phone = new PhoneLinkHost({
  answer: (m) => toNode('answer', m),
  event: (m) => toNode('event', m),
  stream: (s) => { toNode('stream', !!s); void capture.setExternalStream(s) }
})
window.desk = {
  offer: (m) => phone.accept(m),
  send: (id, m) => phone.send(id, m),
  close: (id) => phone.close(id),
  start: (id) => { session.samples = 0; session.sumSq = 0; session.loud = 0; return capture.start(id, false) },
  stop: (id) => capture.stop(id, true)
}
`

const PHONE_ENTRY = `
import { ConvexReactClient } from 'convex/react'
import { PhoneMicLink } from '${webRoot}/src/lib/phone-mic'
import { convexSignaling } from '${webRoot}/src/components/mic/convex-signaling'
window.phone = {
  init(url, token) {
    const client = new ConvexReactClient(url)
    client.setAuth(async () => token)
    this.signaling = convexSignaling(client)
    this.client = client
    this.log = []
  },
  receivers() { return this.signaling.receivers() },
  async inbox(deviceId) { return await this.client.query('micLink:inbox', { deviceId }) },
  async connect(receiver, iceServers) {
    this.link = new PhoneMicLink(this.signaling, {
      deviceId: 'phone-e2e',
      name: 'E2E phone',
      events: {
        phase: (p, d) => this.log.push({ phase: p, detail: d }),
        message: (m) => this.log.push({ message: m })
      }
    })
    try { await this.link.connect(receiver, iceServers); return 'ok' } catch (e) { return 'error: ' + e.message }
  },
  send(t) { return this.link.send({ t }) },
  close() { this.link.close() }
}
`

describe.skipIf(!enabled)('phone as microphone, end to end', () => {
  let dir: string
  let server: Server
  let origin: string
  let browsers: Array<{ close(): Promise<void> }> = []
  // Playwright pages; typed loosely to keep the dependency out of the app's types.
  let desk: any
  let phone: any
  let client: ConvexClient
  let host: PhoneMicHost
  let switchOn = true
  const settingsListeners = new Set<() => void>()
  const levels = new EventEmitter()
  const fromDesk: Array<{ type: string; payload: any }> = []

  class Dictation extends EventEmitter {
    enabled = true
    isListening = false
    isBusy = false
    toggles = 0
    private id = ''
    toggle(): void {
      this.toggles++
      if (!this.isListening) {
        this.id = randomUUID()
        this.isListening = true
        void desk.evaluate((id: string) => (window as any).desk.start(id), this.id)
        this.emit('state', 'listening')
        return
      }
      this.isListening = false
      this.isBusy = true
      this.emit('state', 'processing')
      const id = this.id
      void desk.evaluate((sid: string) => (window as any).desk.stop(sid), id)
      void waitFor(() => fromDesk.find((e) => e.type === 'stopped' && e.payload.id === id), 'stop').then(
        (e) => {
          this.isBusy = false
          const secs = (e.payload.n / 16000).toFixed(1)
          this.emit('entry', { finalText: `Heard ${secs} seconds from the phone.`, mode: 'hands-free' })
          this.emit('state', 'idle')
        }
      )
    }
    handle(): void {}
  }
  const dictation = new Dictation()

  beforeAll(async () => {
    const key = createPrivateKey(readFileSync(keyFile))
    const sub = `user_phonemic_${randomUUID().slice(0, 8)}`
    const token = mintJwt(key, sub)

    // Bundle the two renderers with the code the apps ship.
    dir = mkdtempSync(join(tmpdir(), 'phone-mic-e2e-'))
    writeFileSync(join(dir, 'desk.ts'), DESKTOP_ENTRY)
    writeFileSync(join(dir, 'phone.ts'), PHONE_ENTRY)
    const esbuild = await import('esbuild')
    for (const name of ['desk', 'phone']) {
      await esbuild.build({
        entryPoints: [join(dir, `${name}.ts`)],
        bundle: true,
        format: 'esm',
        outfile: join(dir, `${name}.js`),
        alias: {
          '@backend': backendRoot,
          '@shared': join(desktopRoot, 'src/shared'),
          '@': join(webRoot, 'src')
        },
        nodePaths: [join(webRoot, 'node_modules'), join(desktopRoot, 'node_modules')],
        logLevel: 'error'
      })
    }
    server = createServer((req, res) => {
      const name = req.url === '/desk.js' ? 'desk.js' : req.url === '/phone.js' ? 'phone.js' : null
      if (name) {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end(readFileSync(join(dir, name)))
        return
      }
      const which = req.url?.includes('phone') ? 'phone' : 'desk'
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><script type="module" src="/${which}.js"></script>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    origin = `http://127.0.0.1:${port}`

    const { chromium } = createRequire(import.meta.url)('playwright')
    // The phone's microphone is the speech clip; the desktop has no microphone at all, so any
    // audio it captures came from the phone.
    const phoneBrowser = await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${speechClip}`,
        '--autoplay-policy=no-user-gesture-required'
      ]
    })
    const deskBrowser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
    browsers = [phoneBrowser, deskBrowser]
    desk = await deskBrowser.newPage()
    phone = await phoneBrowser.newPage()
    desk.on('console', (m: { text(): string }) => console.log(`[desk] ${m.text()}`))
    phone.on('console', (m: { text(): string }) => console.log(`[phone] ${m.text()}`))
    await desk.exposeFunction('toNode', (type: string, payload: any) => {
      fromDesk.push({ type, payload })
      if (type === 'answer') host.onAnswer(payload)
      else if (type === 'event') host.onEvent(payload)
      else if (type === 'level') levels.emit('level', payload)
    })
    await desk.goto(`${origin}/desk`)
    await phone.goto(`${origin}/phone`)
    await desk.waitForFunction(() => !!(window as any).desk)
    await phone.waitForFunction(() => !!(window as any).phone)
    await phone.evaluate(([u, t]: [string, string]) => (window as any).phone.init(u, t), [
      convexUrl,
      token
    ])

    // The desktop's main process: the real host on a real Convex client.
    client = new ConvexClient(convexUrl, { skipConvexDeploymentUrlCheck: true })
    let authed = false
    const cloud = new EventEmitter() as EventEmitter & CloudSource
    Object.defineProperty(cloud, 'authedClient', {
      get: () => (authed ? (client as unknown as SignalingClient) : null)
    })
    Object.defineProperty(cloud, 'deviceIdentity', {
      get: () => ({ deviceId: 'desk-e2e', name: 'E2E laptop', platform: 'linux' })
    })
    client.setAuth(
      async () => token,
      (ok) => {
        authed = ok
        cloud.emit('status')
      }
    )
    host = new PhoneMicHost({
      enabled: () => switchOn,
      onSettingsChange: (cb) => {
        settingsListeners.add(cb)
        return () => settingsListeners.delete(cb)
      },
      cloud,
      dictation: dictation as unknown as DictationSource,
      levels,
      overlay: {
        offer: (m) => void desk.evaluate((o: unknown) => (window as any).desk.offer(o), m),
        send: (id, m) =>
          void desk.evaluate(([l, msg]: [string, unknown]) => (window as any).desk.send(l, msg), [id, m]),
        close: (id) => void desk.evaluate((l: string) => (window as any).desk.close(l), id)
      }
    })
    host.start()
    await waitFor(() => host.getStatus().state === 'waiting', 'the desktop to listen')
  }, 90_000)

  afterAll(async () => {
    host?.dispose()
    await client?.close()
    for (const b of browsers) await b.close().catch(() => undefined)
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const phoneLog = async (): Promise<any[]> => await phone.evaluate(() => (window as any).phone.log)
  const messages = async (t: string): Promise<any[]> =>
    (await phoneLog()).filter((e) => e.message?.t === t).map((e) => e.message)

  async function link(): Promise<void> {
    const list = await phone.evaluate(() => (window as any).phone.receivers())
    const receiver = list.receivers.find((r: { deviceId: string }) => r.deviceId === 'desk-e2e')
    expect(receiver).toMatchObject({ name: 'E2E laptop', platform: 'linux' })
    const result = await phone.evaluate(
      ([r, ice]: [unknown, unknown]) => (window as any).phone.connect(r, ice),
      [receiver, list.iceServers]
    )
    expect(result).toBe('ok')
    await waitFor(() => host.getStatus().state === 'connected', 'the link to connect')
  }

  it('links, streams the phone speech into the desktop capture and reports back', async () => {
    await link()
    const status: PhoneMicStatus = host.getStatus()
    expect(status).toMatchObject({ state: 'connected', phoneName: 'E2E phone' })
    // Both machines here are one host: the candidates meet directly.
    expect(status.route).toBe('direct')
    let welcome: any[] = []
    for (let i = 0; i < 100 && !welcome.length; i++) {
      welcome = await messages('welcome')
      if (!welcome.length) await new Promise((r) => setTimeout(r, 100))
    }
    expect(welcome[0]).toMatchObject({ name: 'E2E laptop', state: 'idle' })
    await waitFor(() => fromDesk.some((e) => e.type === 'stream' && e.payload === true), 'audio track')

    expect(await phone.evaluate(() => (window as any).phone.send('start'))).toBe(true)
    await waitFor(() => dictation.isListening, 'the dictation to start')
    await new Promise((r) => setTimeout(r, 6_000))
    await phone.evaluate(() => (window as any).phone.send('stop'))
    const stopped = await waitFor(
      () => fromDesk.find((e) => e.type === 'stopped')?.payload,
      'the capture to stop'
    )
    console.log(`desktop captured ${stopped.n} samples, rms ${stopped.rms.toFixed(4)}, loud ${stopped.loud}`)
    // About six seconds of 16 kHz audio, and it is speech, not silence.
    expect(stopped.n).toBeGreaterThan(16_000 * 5)
    expect(stopped.rms).toBeGreaterThan(0.01)
    expect(stopped.loud).toBeGreaterThan(16_000 * 1)

    let results: any[] = []
    for (let i = 0; i < 100 && !results.length; i++) {
      results = await messages('result')
      if (!results.length) await new Promise((r) => setTimeout(r, 100))
    }
    expect(results[0].text).toMatch(/^Heard \d+\.\d seconds from the phone\.$/)
    const states = (await messages('state')).map((m) => m.state)
    expect(states).toEqual(expect.arrayContaining(['listening', 'processing', 'idle']))
    expect((await messages('level')).length).toBeGreaterThan(5)
  }, 60_000)

  it('leaves no signaling rows behind', async () => {
    for (const deviceId of ['desk-e2e', 'phone-e2e']) {
      expect(await client.query(api.micLink.inbox, { deviceId })).toEqual([])
    }
  })

  it('ends the dictation with what was said when the phone hangs up', async () => {
    fromDesk.length = 0
    const toggles = dictation.toggles
    await phone.evaluate(() => (window as any).phone.send('start'))
    await waitFor(() => dictation.isListening, 'the dictation to start')
    await new Promise((r) => setTimeout(r, 2_000))
    await phone.evaluate(() => (window as any).phone.close())
    await waitFor(() => !dictation.isListening, 'the dictation to end', 10_000)
    expect(dictation.toggles).toBe(toggles + 2)
    const stopped = await waitFor(
      () => fromDesk.find((e) => e.type === 'stopped')?.payload,
      'the capture to stop'
    )
    expect(stopped.n).toBeGreaterThan(16_000)
    await waitFor(() => host.getStatus().state === 'waiting', 'the desktop to listen again')
  }, 30_000)

  it('links again after a hang-up', async () => {
    await phone.evaluate(() => ((window as any).phone.log = []))
    await link()
    expect(host.getStatus().state).toBe('connected')
  }, 30_000)

  it('stops being listed, and refuses links, once switched off', async () => {
    switchOn = false
    settingsListeners.forEach((cb) => cb())
    await waitFor(() => host.getStatus().state === 'off', 'the switch to apply')
    let list: any
    for (let i = 0; i < 50; i++) {
      list = await phone.evaluate(() => (window as any).phone.receivers())
      if (!list.receivers.length) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(list.receivers).toEqual([])
    const result = await phone.evaluate(
      (ice: unknown) =>
        (window as any).phone.connect(
          { deviceId: 'desk-e2e', name: 'E2E laptop', platform: 'linux', registeredAt: 0 },
          ice
        ),
      list.iceServers
    )
    expect(result).toMatch(/not_listening/)
    const log = await phoneLog()
    expect(log.at(-1)).toMatchObject({ phase: 'closed', detail: expect.stringMatching(/not listening/) })
  }, 30_000)
})
