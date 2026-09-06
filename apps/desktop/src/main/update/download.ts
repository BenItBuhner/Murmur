import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UpdateProgress } from '@shared/updates'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface DownloadOptions {
  fetch: FetchLike
  dest: string
  /** Size advertised by the release; used for progress and as a sanity check. */
  expectedSize?: number
  /** Lowercase hex digest the file must hash to. The file is deleted when it does not. */
  expectedSha256: string | null
  onProgress?: (progress: UpdateProgress) => void
  signal?: AbortSignal
  /** Minimum interval between progress callbacks. */
  progressIntervalMs?: number
}

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super('Downloaded file failed its SHA-256 check')
    this.name = 'ChecksumMismatchError'
  }
}

/**
 * Stream `url` to `dest`, hashing as it goes. Writes to `dest.part` and renames on success so a
 * half-finished download can never be mistaken for a verified one.
 */
export async function downloadFile(
  url: string,
  opts: DownloadOptions
): Promise<{ sha256: string; size: number }> {
  const res = await opts.fetch(url, {
    signal: opts.signal,
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'Murmur-Updater' }
  })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('Download failed: empty response')

  const total =
    opts.expectedSize && opts.expectedSize > 0
      ? opts.expectedSize
      : Number(res.headers.get('content-length') ?? 0)
  const part = `${opts.dest}.part`
  mkdirSync(dirname(opts.dest), { recursive: true })
  rmSync(part, { force: true })
  const out = createWriteStream(part)
  const hash = createHash('sha256')
  const started = Date.now()
  let transferred = 0
  let lastReport = 0
  const interval = opts.progressIntervalMs ?? 200

  const report = (force: boolean): void => {
    const now = Date.now()
    if (!force && now - lastReport < interval) return
    lastReport = now
    const elapsed = Math.max(1, now - started) / 1000
    opts.onProgress?.({
      percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
      transferred,
      total,
      bytesPerSecond: transferred / elapsed
    })
  }

  const reader = res.body.getReader()
  try {
    report(true)
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      hash.update(value)
      transferred += value.byteLength
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      report(false)
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject)
      out.end(() => resolve())
    })
  } catch (err) {
    out.destroy()
    rmSync(part, { force: true })
    throw err
  }
  report(true)

  if (opts.expectedSize && opts.expectedSize > 0 && transferred !== opts.expectedSize) {
    rmSync(part, { force: true })
    throw new Error(`Download is ${transferred} bytes, expected ${opts.expectedSize}`)
  }
  const sha256 = hash.digest('hex')
  if (opts.expectedSha256 && sha256 !== opts.expectedSha256.toLowerCase()) {
    rmSync(part, { force: true })
    throw new ChecksumMismatchError(opts.expectedSha256.toLowerCase(), sha256)
  }
  rmSync(opts.dest, { force: true })
  renameSync(part, opts.dest)
  return { sha256, size: transferred }
}
