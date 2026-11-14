import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expected } from '../../scripts/sync-engine.mjs'

describe('src/lib/engine', () => {
  it('is an exact copy of the text engine files /dictate uses (npm run sync:engine)', () => {
    const dir = fileURLToPath(new URL('./engine/', import.meta.url))
    const want = expected() as Record<string, string>
    expect(readdirSync(dir).sort()).toEqual(Object.keys(want).sort())
    for (const [name, body] of Object.entries(want))
      expect(readFileSync(dir + name, 'utf8')).toBe(body)
  })
})
