import { defineConfig } from 'vitest/config'

// Pure logic only, so the root `pnpm -r test` needs no browser. The Playwright
// specs in tests/ run in their own CI job.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['fill/**/*.test.ts', 'lib/**/*.test.ts', 'relay/**/*.test.ts', 'scripts/**/*.test.ts', 'ui/**/*.test.ts'],
  },
})
