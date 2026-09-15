import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'eval/**/*.test.ts'],
    exclude: process.env.MURMUR_LIVE ? [] : ['eval/live.test.ts'],
    testTimeout: process.env.MURMUR_LIVE ? 120_000 : 10_000,
    environment: 'node'
  }
})
