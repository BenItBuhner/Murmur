import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextMiddleware } from 'next/server'

/**
 * Clerk runs only for the account page, so every other route is served without it. Without an
 * instance configured (no keys) this is a pass-through and /account renders its "accounts are not
 * switched on" state instead.
 *
 * This is a `middleware` file on the edge runtime rather than Next 16's `proxy`, which always runs
 * on Node.js: on Cloudflare Workers (@opennextjs/cloudflare) Node middleware is experimental and
 * bundles a second copy of the Next runtime, about 1.1 MiB of the Free plan's 3 MiB compressed
 * limit, while the edge bundle is the adapter's supported path and holds only Clerk. Next 16 warns
 * that the convention is deprecated but keeps it working; once the adapter supports Node
 * middleware, `npx @next/codemod@canary middleware-to-proxy .` moves this back.
 */
const configured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
)

const passthrough: NextMiddleware = () => NextResponse.next()

export default configured ? clerkMiddleware() : passthrough

export const config = {
  matcher: ['/account(.*)']
}
