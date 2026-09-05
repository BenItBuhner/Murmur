import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net, protocol, session } from 'electron'
import { createClerkBridge, type ClerkBridge } from '@clerk/electron'
import { storage } from '@clerk/electron/storage'
import type { CloudConfig } from '@shared/cloud'
import { createLogger } from '../logger'

const log = createLogger('cloud:clerk')

export const RENDERER_HOST = 'app'

export function rendererOrigin(scheme: string): string {
  return `${scheme}://${RENDERER_HOST}`
}

/**
 * Register Clerk's main-process bridge. Must run before `app.whenReady()` because it registers the
 * privileged custom scheme the packaged renderer is served from (Clerk needs a stable, secure
 * origin; `file://` is neither).
 */
export function createClerk(config: CloudConfig, userDataPath: string): ClerkBridge {
  const bridge = createClerkBridge({
    // Tokens are encrypted with the OS keystore. Where none exists (a Linux box without a keyring)
    // they fall back to plaintext on disk - the same trade-off the app already makes for API keys -
    // so users are not signed out on every launch.
    storage: storage({ name: 'clerk-tokens', path: userDataPath, unencryptedFallback: true }),
    // Registers `scheme://app` as a privileged (standard, secure, fetch-capable) origin and wires the
    // OAuth deep-link transport (`open-url` / `second-instance`).
    renderer: { scheme: config.deepLinkScheme, host: RENDERER_HOST },
    // main/index.ts already owns the single-instance lock.
    manageSingleInstanceLock: false,
    userAgent: `Murmur/${app.getVersion()}`
  })
  log.info(
    `clerk bridge ready (scheme ${config.deepLinkScheme}://, fapi ${config.clerkFrontendApiHost})`
  )
  return bridge
}

/** Let the OS route `murmur://` links (OAuth callbacks from the system browser) to this app. */
export function registerDeepLinkHandler(scheme: string): void {
  try {
    const registered =
      process.defaultApp && process.argv.length >= 2
        ? app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])])
        : app.setAsDefaultProtocolClient(scheme)
    if (!registered) log.warn(`could not register as handler for ${scheme}://`)
  } catch (err) {
    log.warn(`could not register as handler for ${scheme}://`, err)
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json'
}

/**
 * Serve the built renderer from `scheme://app/`. Unknown paths fall back to index.html so Clerk's
 * `/sso-callback` deep link lands on the app. Call after `app.whenReady()`.
 */
export function serveRenderer(scheme: string, rendererDir: string, csp: string): void {
  const root = resolve(rendererDir)
  protocol.handle(scheme, async (request) => {
    const url = new URL(request.url)
    if (url.host !== RENDERER_HOST) return new Response('Not found', { status: 404 })
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || !extname(pathname)) pathname = '/index.html'
    const file = normalize(join(root, pathname))
    if (!(file === root || file.startsWith(root + sep))) {
      return new Response('Forbidden', { status: 403 })
    }
    if (!existsSync(file) || !statSync(file).isFile())
      return new Response('Not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    const type = MIME[extname(file).toLowerCase()]
    if (type) headers.set('Content-Type', type)
    if (extname(file) === '.html') headers.set('Content-Security-Policy', csp)
    return new Response(response.body, { status: response.status, headers })
  })
  log.info(`serving renderer from ${root} at ${rendererOrigin(scheme)}/`)
}

/**
 * In development the renderer is served by Vite over http://localhost; attach the CSP as a response
 * header there so the dev build exercises the same policy as the packaged one.
 */
export function installDevCsp(csp: string, devServerUrl: string): void {
  let origin: string
  try {
    origin = new URL(devServerUrl).origin
  } catch {
    return
  }
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      if (details.resourceType !== 'mainFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
      })
    }
  )
}
