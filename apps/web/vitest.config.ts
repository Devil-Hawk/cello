// Minimal vitest config, needed only so `@/*` imports resolve the same way
// they do for `tsc`/Next (see tsconfig.json's `paths`). Test files that never
// transitively import anything under `@/` (e.g. lib/jobs/classify.test.ts)
// never needed this; lib/dossier/visa.test.ts does, since visa.ts itself
// imports `@/lib/harness/*` — without this alias, vitest's module resolver
// fails to load the file at all (not a test failure, a "file does not exist"
// resolution error), so this isn't optional tooling polish.
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  // Only needed once a test imports a .tsx component (e.g.
  // components/copilot/observation-view.test.tsx, which renders the real
  // ObservationView via react-dom/server to catch UI-shape regressions).
  // Those source files never `import React` — Next's own SWC transform
  // handles that at build time — but vite's default esbuild JSX transform
  // is classic mode, which needs `React` in scope and throws "React is not
  // defined" without it. 'automatic' matches what Next/SWC already does, so
  // this doesn't change how any component behaves, only how the test runner
  // compiles JSX. No new dependency: esbuild's automatic runtime is built
  // into vite itself, just off by default since not every project uses
  // React.
  esbuild: {
    jsx: 'automatic',
  },
})
