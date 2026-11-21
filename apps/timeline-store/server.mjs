/**
 * Private timeline audio store for the CasaOS host. The inference Worker is the only client.
 * There is no list route. Each request carries an HMAC of method, path, timestamp and body hash.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

const root = process.env.TIMELINE_DIR || '/data/timeline'
const secret = process.env.TIMELINE_STORE_SECRET || ''
const maxBytes = Number(process.env.TIMELINE_MAX_BYTES || 20 * 1024 * 1024 * 1024)
const keepMs = Number(process.env.TIMELINE_KEEP_MS || 7 * 24 * 60 * 60 * 1000)
const port = Number(process.env.PORT || 8788)
const skewMs = 5 * 60 * 1000

if (secret.length < 32) {
  console.error('TIMELINE_STORE_SECRET must be at least 32 characters')
  process.exit(1)
}

await mkdir(root, { recursive: true })

function safePath(urlPath) {
  const prefix = '/objects/'
  if (!urlPath.startsWith(prefix)) return null
  let key
  try {
    key = urlPath.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (!key || key.includes('..') || key.startsWith('/')) return null
  const full = normalize(join(root, key))
  if (full !== root && !full.startsWith(root + sep)) return null
  return { key, full }
}

function hexEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function authorized(method, urlPath, body, headers) {
  const ts = Number(headers['x-timeline-ts'])
  const sha = headers['x-timeline-sha256']
  const signature = headers['x-timeline-signature']
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skewMs) return false
  const hash = createHash('sha256').update(body).digest('hex')
  if (!hexEqual(sha, hash)) return false
  const expected = createHmac('sha256', secret).update(`${method}\n${urlPath}\n${ts}\n${hash}`).digest('hex')
  return hexEqual(signature, expected)
}

async function bytesUsed(dir) {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await bytesUsed(full)
    else if (entry.isFile()) total += (await stat(full)).size
  }
  return total
}

async function sweep(dir) {
  const cutoff = Date.now() - keepMs
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await sweep(full)
    else if (entry.isFile() && (await stat(full)).mtimeMs < cutoff) await rm(full, { force: true })
  }
}

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200)
    res.end('ok')
    return
  }
  const url = new URL(req.url || '/', 'http://localhost')
  const target = safePath(url.pathname)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  if (!target || !authorized(req.method || 'GET', url.pathname, body, req.headers)) {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }
  try {
    if (req.method === 'PUT') {
      const used = await bytesUsed(root)
      if (used + body.length > maxBytes) {
        res.writeHead(507)
        res.end('disk quota')
        return
      }
      await mkdir(dirname(target.full), { recursive: true })
      await writeFile(target.full, body)
      res.writeHead(201)
      res.end('stored')
      return
    }
    if (req.method === 'GET') {
      const file = await readFile(target.full).catch(() => null)
      if (!file) {
        res.writeHead(404)
        res.end('missing')
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(file)
      return
    }
    if (req.method === 'DELETE') {
      await rm(target.full, { force: true })
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(405)
    res.end('method')
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    res.writeHead(500)
    res.end('error')
  }
})

setInterval(() => void sweep(root), 60 * 60 * 1000).unref()
server.listen(port, '0.0.0.0', () => console.log(`timeline store listening on ${port}`))
