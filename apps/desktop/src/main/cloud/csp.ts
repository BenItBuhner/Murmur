export interface CspOptions {
  /** Clerk Frontend API host; the prebuilt UI script and all auth requests come from it. */
  clerkFrontendApiHost?: string
  /** Loosen rules needed by Vite's dev server (HMR, eval). */
  dev: boolean
}

/**
 * Content Security Policy for the settings window. Replaces the static meta tag so the Clerk hosts
 * only appear when a cloud instance is configured.
 */
export function buildRendererCsp({ clerkFrontendApiHost, dev }: CspOptions): string {
  const clerk = clerkFrontendApiHost ? `https://${clerkFrontendApiHost}` : ''
  const script = ["'self'", "'unsafe-inline'", clerk, clerk && 'https://challenges.cloudflare.com']
  // The overlay's AudioWorklet module is a blob: URL; in dev the overlay is served under this
  // policy too (packaged builds load it from file://, where it does not apply).
  if (dev) script.push("'unsafe-eval'", 'blob:')
  const connect = ["'self'", clerk, clerk && 'https://clerk-telemetry.com']
  if (dev)
    connect.push('ws://localhost:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'http://127.0.0.1:*')
  const frame = ["'self'", clerk && 'https://challenges.cloudflare.com']

  const directives: Array<[string, Array<string | ''>]> = [
    ['default-src', ["'self'"]],
    ['script-src', script],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // Account avatars come from Clerk and whichever OAuth provider the user signed in with.
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect],
    ['media-src', ["'self'", 'blob:']],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', frame],
    ['form-action', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]]
  ]
  return directives
    .map(([name, values]) => `${name} ${values.filter(Boolean).join(' ')}`)
    .join('; ')
}
