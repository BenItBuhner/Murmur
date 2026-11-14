import { gatewayOrigin } from '@/lib/env'

/*
 * The web dictation page's way to the managed-model gateway, the same one the desktop and Android
 * apps call: the inference Worker when the build knows it, otherwise the Convex deployment's HTTP
 * actions (desktop `managedOrigin`). Neither sends CORS headers, so the page calls this route on
 * its own origin and it forwards the request untouched, Clerk token included. Only the dictation
 * routes pass; the gateway checks the token as for any app.
 */
const ALLOWED = new Set(['audio/transcriptions', 'format'])

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  const path = (await params).path.join('/')
  const origin = gatewayOrigin()
  if (!origin)
    return error(503, 'Murmur models are not switched on for this site', 'not_configured')
  if (!path.startsWith('v1/') || !ALLOWED.has(path.slice(3)))
    return error(404, 'Not found', 'not_found')
  const headers = new Headers()
  for (const name of ['authorization', 'content-type', 'x-murmur-tier']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  let upstream: Response
  try {
    upstream = await fetch(`${origin}/${path}`, {
      method: 'POST',
      headers,
      body: await request.arrayBuffer()
    })
  } catch {
    return error(
      502,
      "Couldn't reach Murmur's speech server; check your connection and try again",
      'unreachable'
    )
  }
  const out = new Headers({ 'Cache-Control': 'no-store' })
  for (const name of ['content-type', 'x-murmur-speed', 'x-murmur-speed-fallback', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value) out.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

function error(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: 'murmur_gateway_error', code } }, { status })
}
