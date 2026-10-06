import { defineConfig } from '@playwright/test'

// One worker: every spec shares the stub server on 127.0.0.1:4599, which the
// test build bakes in as the Cello origin.
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],
  use: { trace: 'retain-on-failure' },
})
