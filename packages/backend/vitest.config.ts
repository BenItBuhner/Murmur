import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // convex-test runs functions in an edge-like runtime that matches Convex's isolate.
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000
  }
})
