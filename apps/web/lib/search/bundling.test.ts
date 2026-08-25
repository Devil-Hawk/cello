// Guards the one property the lib/search unit tests structurally CANNOT check:
// that each optional search backend is actually bundled into the server output.
//
// Why this file exists. An earlier version of loadOptionalBackendFn() took the
// module path as a parameter and called `import(modulePath)`. Every unit test
// passed, tsc was clean, `next build` succeeded with only a "Critical
// dependency: the request of a dependency is an expression" warning — and the
// feature was dead in production. webpack only bundles a dynamic import whose
// specifier it can resolve statically; given an opaque one it bundles nothing,
// so at runtime the import threw, the catch swallowed it, and Tavily/Serper/
// SearXNG reported as "code not present" — which reads as "add a key" when the
// truth is "never shipped". The unit tests could not have caught it: vitest
// resolves the relative TS path natively through Node/Vite, so they exercised
// a code path a webpack bundle cannot have. Only the compiled output can tell
// the truth, so that is what this file reads.
//
// Coverage note, stated honestly: this asserts Tavily and Serper, which are the
// two backends with unique, unmanglable string literals (their API endpoints).
// SearXNG has no such marker — its base URL is user-supplied — so it is not
// directly asserted. That is acceptable because all three load through the SAME
// map in lib/search/index.ts: a regression to a non-statically-analyzable
// specifier drops all three together, so either assertion catches it.
//
// Skips (does not fail) when no build output is present, so `vitest run` on a
// clean checkout stays green. It therefore only bites after a build — run it
// AFTER `pnpm build` in CI for the guard to be load-bearing.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const distDir = process.env.NEXT_DIST_DIR || '.next'
const serverDir = path.resolve(process.cwd(), distDir, 'server')
const hasBuildOutput = fs.existsSync(serverDir)

/** True if any compiled server chunk contains `marker`. Walks lazily and stops
 *  at the first hit — the server output is large and reading it all into one
 *  string would be gratuitous. */
function bundleContains(marker: string): boolean {
  const stack: string[] = [serverDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable dir — treat as "not here", never crash the suite
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        try {
          if (fs.readFileSync(full, 'utf8').includes(marker)) return true
        } catch {
          // unreadable chunk — keep scanning the rest
        }
      }
    }
  }
  return false
}

// The anchor decides whether the scan can be TRUSTED, not whether the code is
// correct. duckduckgo is a plain static import, so if its marker is absent the
// search routes simply have not been compiled into this build — which is the
// normal state of a freshly restarted `next dev`, since dev compiles routes on
// demand. Asserting anything then would be a false negative, so the suite skips
// and says why. This is the difference between "the backends are missing" and
// "I cannot see the backends from here", and only the first is a bug.
const scanIsTrustworthy = hasBuildOutput && bundleContains('html.duckduckgo.com')

const describeIfBuilt = scanIsTrustworthy ? describe : describe.skip

if (hasBuildOutput && !scanIsTrustworthy) {
  console.warn(
    '[bundling.test] Build output exists but contains no search routes — skipping. ' +
      'A `next dev` server compiles routes on demand, so this is expected until a page ' +
      'importing lib/search has been requested. Run against a production build to make ' +
      'this guard load-bearing.'
  )
}

describeIfBuilt('optional search backends are present in the compiled server output', () => {

  it.each([
    ['tavily', 'api.tavily.com'],
    ['serper', 'google.serper.dev'],
  ])('bundles the %s backend implementation', (_id, marker) => {
    expect(bundleContains(marker)).toBe(true)
  })
})
