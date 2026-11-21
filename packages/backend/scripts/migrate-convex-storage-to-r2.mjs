/**
 * Copy every Convex `_storage` file on a deployment to the private R2 bucket `murmur-timeline`,
 * check size and sha256, point timeline rows at the object key, and only then delete the Convex file.
 *
 * Does not run unless both of these are true:
 *   - CONVEX_DEPLOY_KEY is set (a deploy key for the deployment; never printed)
 *   - R2 is enabled on the Cloudflare account and `npx wrangler` can see bucket murmur-timeline
 *
 * A file that does not match is left in Convex and printed. Nothing is deleted on a mismatch.
 *
 *   CONVEX_DEPLOY_KEY=... node scripts/migrate-convex-storage-to-r2.mjs
 *
 * hardy-fish-542 returns 500 for every function while it is over its free-plan caps, so this
 * script cannot succeed there until the deployment serves again. R2 also has to be enabled first
 * (Cloudflare dashboard checkout). This script does not enable R2 and does not add a payment method.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bucket = 'murmur-timeline'
// Serving a Convex file counts as data egress. The free plan allows 1 GB a month, and the
// deployment is already at 2.65 GB. A full 2.24 GB copy in one month would trip the cap again.
// This cap leaves headroom; raise MAX_BYTES only when that month's egress can hold the download.
const maxBytes = Number(process.env.MAX_BYTES ?? 700_000_000)

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!process.env.CONVEX_DEPLOY_KEY) fail('CONVEX_DEPLOY_KEY is not set. Nothing was copied or deleted.')

const probe = spawnSync('npx', ['wrangler', 'r2', 'bucket', 'info', bucket], {
  cwd: root,
  encoding: 'utf8'
})
if (probe.status !== 0) {
  const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  if (/enable R2|10042|not enabled/i.test(text)) {
    fail('R2 is not enabled on this Cloudflare account. No files were copied or deleted.')
  }
  fail(`Cannot see R2 bucket ${bucket}. No files were copied or deleted.\n${text.slice(0, 500)}`)
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
    const put = spawnSync(
      'npx',
      ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--content-type', file.contentType || 'application/octet-stream', '--pipe'],
      { cwd: root, input: bytes }
    )
    if (put.status !== 0) {
      kept.push({ id: file.id, reason: 'R2 upload failed' })
      continue
    }
    const head = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'], {
      cwd: root
    })
    const stored = Buffer.from(head.stdout ?? [])
    const storedSha = createHash('sha256').update(stored).digest('hex')
    if (head.status !== 0 || stored.length !== file.size || storedSha !== file.sha256) {
      kept.push({ id: file.id, reason: 'R2 object did not match sha256 or size' })
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
