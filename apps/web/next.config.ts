import type { NextConfig } from 'next'

/**
 * The site is static-first: every page is prerendered and the two release endpoints revalidate on
 * a timer, so it runs the same on Cloudflare Workers (wrangler.jsonc and open-next.config.ts, the
 * production host), on `next start` behind any reverse proxy, or in a container. Nothing here
 * depends on the host.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this directory.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // No other site may frame these pages (the account page included): clickjacking.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ]
      },
      {
        // The phone microphone page is the one page that may use the microphone. Later rules
        // override earlier ones for the same header.
        source: '/mic',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' }
        ]
      },
      {
        // Web dictation records too.
        source: '/dictate',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' }
        ]
      }
    ]
  }
}

export default nextConfig
