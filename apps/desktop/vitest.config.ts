import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vitest/config'

/** electron-vite's `?asset` imports resolve to a file path at build time; tests get an empty one. */
const assetStub: Plugin = {
  name: 'murmur-asset-stub',
  enforce: 'pre',
  resolveId(id) {
    return id.endsWith('?asset') ? `\0asset:${id}` : null
  },
  load(id) {
    return id.startsWith('\0asset:') ? 'export default ""' : null
  }
}

export default defineConfig({
  plugins: [assetStub],
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared'),
      '@engine': resolve('../../packages/text-engine/src')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.MURMUR_LIVE ? [] : ['tests/live/**'],
    testTimeout: process.env.MURMUR_LIVE ? 120_000 : 10_000,
    environment: 'node'
  }
})
