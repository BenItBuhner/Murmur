import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: process.env.MURMUR_LIVE ? [] : ['tests/live/**'],
    testTimeout: process.env.MURMUR_LIVE ? 120_000 : 10_000,
    environment: 'node'
  }
})
