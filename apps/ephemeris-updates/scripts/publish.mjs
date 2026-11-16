#!/usr/bin/env node
// Publish a desktop build to the Ephemeris update feed:
//   EPHEMERIS_UPDATE_API_BASE=https://<worker>/<FEED_KEY> EPHEMERIS_FEED_PUBLISH_KEY=... \
//     node scripts/publish.mjs <version> <file> [<file>...] [--notes "text"]
// Uploads each file under v<version>/ in 24 MiB chunks, then adds (or replaces) the release in releases.json.
// Needs Node 18+ and nothing else (no wrangler, no Cloudflare login).
import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, statSync, createReadStream } from 'node:fs'
import { basename } from 'node:path'

const PART = 24 * 1024 * 1024 // the Worker's MAX_CHUNK (KV caps a value at 25 MiB)
const args = process.argv.slice(2)
const notesAt = args.indexOf('--notes')
const notes = notesAt >= 0 ? args.splice(notesAt, 2)[1] : ''
const [version, ...files] = args
const base = (process.env.EPHEMERIS_UPDATE_API_BASE ?? '').replace(/\/+$/, '')
const publishKey = process.env.EPHEMERIS_FEED_PUBLISH_KEY ?? ''
if (
  !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '') ||
  files.length === 0 ||
  !base ||
  !publishKey
) {
  console.error(
    'usage: EPHEMERIS_UPDATE_API_BASE=... EPHEMERIS_FEED_PUBLISH_KEY=... publish.mjs <version> <file>... [--notes "text"]'
  )
  process.exit(2)
}
const tag = `v${version}`
const auth = { Authorization: `Bearer ${publishKey}` }

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${base}/${path}`, { method, body, headers: { ...auth, ...headers } })
  if (!res.ok)
    throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

const assets = []
for (const file of files) {
  const name = basename(file)
  const size = statSync(file).size
  const digest = await sha256(file)
  const path = `upload/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  console.log(`uploading ${name} (${size} bytes, sha256 ${digest})`)
  const fd = openSync(file, 'r')
  let parts = 0
  try {
    for (let offset = 0; offset < size; offset += PART, parts++) {
      const buf = Buffer.alloc(Math.min(PART, size - offset))
      readSync(fd, buf, 0, buf.length, offset)
      await call('PUT', `${path}?part=${parts}`, buf)
      console.log(`  part ${parts}: ${Math.min(offset + PART, size)} / ${size}`)
    }
  } finally {
    closeSync(fd)
  }
  await call('POST', `${path}?complete&parts=${parts}`)
  assets.push({ name, size, sha256: digest })
}

const current = await fetch(`${base}/repos/BenItBuhner/Ephemeris/releases`).then((r) => r.json())
const manifest = current
  .filter((r) => r.tag_name !== tag)
  .map((r) => ({
    tag_name: r.tag_name,
    name: r.name,
    body: r.body,
    published_at: r.published_at,
    prerelease: r.prerelease,
    assets: r.assets.map((a) => ({
      name: a.name,
      size: a.size,
      sha256: a.digest.replace(/^sha256:/, '')
    }))
  }))
manifest.unshift({
  tag_name: tag,
  name: `Ephemeris ${version}`,
  body: notes,
  published_at: new Date().toISOString(),
  assets
})
await call('PUT', 'manifest', JSON.stringify(manifest), { 'Content-Type': 'application/json' })
console.log(`published ${tag}: ${assets.map((a) => `${a.name} ${a.sha256}`).join(', ')}`)
