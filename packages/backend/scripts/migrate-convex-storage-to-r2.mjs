/**
 * Copy every Convex `_storage` file to the home-lab timeline store through its signed API,
 * check size and sha256, point timeline rows at the object key, and only then delete the Convex file.
 *
 *   CONVEX_DEPLOY_KEY=... TIMELINE_STORE_URL=https://... TIMELINE_STORE_SECRET=... \
 *     node scripts/migrate-convex-storage-to-r2.mjs
 *
 * The secret is never printed. A mismatch stays in Convex and is listed. Downloads count as Convex
 * data egress, so a run stops at MAX_BYTES (default 700 MB).
 *
 * hardy-fish-542 returns 500 for every function while it is over its free-plan caps, so this
 * script cannot succeed there until the deployment serves again.
 */
import { createHash, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeUrl = (process.env.TIMELINE_STORE_URL ?? '').replace(/\/+$/, '')
const storeSecret = process.env.TIMELINE_STORE_SECRET ?? ''
// Serving a Convex file counts as data egress. The free plan allows 1 GB a month, and the
// deployment is already at 2.65 GB. A full 2.24 GB copy in one month would trip the cap again.
// This cap leaves headroom; raise MAX_BYTES only when that month's egress can hold the download.
const maxBytes = Number(process.env.MAX_BYTES ?? 700_000_000)

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!process.env.CONVEX_DEPLOY_KEY) fail('CONVEX_DEPLOY_KEY is not set. Nothing was copied or deleted.')
if (!storeUrl || storeSecret.length < 32) fail('TIMELINE_STORE_URL and TIMELINE_STORE_SECRET are required. Nothing was copied or deleted.')

function storePath(key) {
  return `/objects/${key.split('/').map(encodeURIComponent).join('/')}`
}

async function signedStore(method, key, body) {
  const path = storePath(key)
  const sha = createHash('sha256').update(body).digest('hex')
  const ts = String(Date.now())
  const signature = createHmac('sha256', storeSecret).update(`${method}\n${path}\n${ts}\n${sha}`).digest('hex')
  return await fetch(`${storeUrl}${path}`, {
    method,
    headers: {
      'x-timeline-ts': ts,
      'x-timeline-sha256': sha,
      'x-timeline-signature': signature,
      'content-type': 'application/octet-stream'
    },
    body: method === 'GET' ? undefined : body
  })
}

function convex(functionName, args) {
  const run = spawnSync('npx', ['convex', 'run', functionName, JSON.stringify(args)], {
    cwd: root,
    encoding: 'utf8',
    env: process.env
  })
  if (run.status !== 0) fail(`convex run ${functionName} failed.\n${(run.stderr || run.stdout || '').slice(0, 500)}`)
  const line = (run.stdout || '').trim().split('\n').filter(Boolean).at(-1) ?? ''
  return JSON.parse(line)
}

function objectKeyFor(file) {
  return `convex-storage/${file.id}`
}

const kept = []
let copied = 0
let deleted = 0
let bytesOut = 0
let cursor = null
for (;;) {
  const page = convex('timeline:storagePage', { cursor, numItems: 20 })
  for (const file of page.files) {
    const key = objectKeyFor(file)
    if (bytesOut + file.size > maxBytes) {
      kept.push({ id: file.id, reason: `stopped before ${file.size} bytes would pass MAX_BYTES (${maxBytes})` })
      continue
    }
    const url = convex('timeline:storageUrl', { id: file.id })
    if (!url) {
      kept.push({ id: file.id, reason: 'no download url' })
      continue
    }
    const res = await fetch(url)
    if (!res.ok) {
      kept.push({ id: file.id, reason: `download HTTP ${res.status}` })
      continue
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    bytesOut += bytes.length
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== file.sha256 || bytes.length !== file.size) {
      kept.push({ id: file.id, reason: 'download did not match Convex metadata' })
      continue
    }
    const put = await signedStore('PUT', key, bytes)
    if (!put.ok) {
      kept.push({ id: file.id, reason: `store upload HTTP ${put.status}` })
      continue
    }
    const head = await signedStore('GET', key, Buffer.alloc(0))
    const stored = Buffer.from(await head.arrayBuffer())
    const storedSha = createHash('sha256').update(stored).digest('hex')
    if (!head.ok || stored.length !== file.size || storedSha !== file.sha256) {
      kept.push({ id: file.id, reason: 'stored object did not match sha256 or size' })
      continue
    }
    const linked = convex('timeline:linkStorage', { storageId: file.id, objectKey: key, sha256, size: file.size })
    if (!linked.ok) {
      kept.push({ id: file.id, reason: `link refused: ${linked.reason}` })
      continue
    }
    const dropped = convex('timeline:dropStorage', { storageId: file.id, objectKey: key, sha256, size: file.size })
    if (!dropped.ok) {
      kept.push({ id: file.id, reason: `delete refused: ${dropped.reason}` })
      continue
    }
    copied++
    deleted++
  }
  if (page.isDone) break
  cursor = page.continueCursor
}

console.log(`copied ${copied}, deleted from Convex ${deleted}, downloaded ${bytesOut} bytes, kept in Convex ${kept.length}`)
for (const item of kept) console.log(`kept ${item.id}: ${item.reason}`)
if (kept.length) process.exitCode = 2
