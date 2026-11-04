import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('mic-protocol copy', () => {
  it('is the backend protocol, unchanged', () => {
    const original = readFileSync(
      fileURLToPath(new URL('../../../../packages/backend/convex/lib/micProtocol.ts', import.meta.url)),
      'utf8'
    )
    const copy = readFileSync(fileURLToPath(new URL('./mic-protocol.ts', import.meta.url)), 'utf8')
    // Run `npm run sync:mic-protocol` after changing the backend file.
    expect(copy.slice(copy.indexOf('\n') + 1)).toBe(original)
  })
})
