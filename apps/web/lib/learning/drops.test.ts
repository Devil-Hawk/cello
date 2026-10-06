// Migration 20261015000001 drops public.insights, public.strategy_proposal_outcomes and the
// functions around them. It may be applied only once nothing reads them, so this fails while
// any code outside migrations and tests still names the old stores or the distiller.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOTS = ['lib', 'app', 'components', 'scripts', 'prompts', 'skills', 'hooks'].map((r) => path.resolve(process.cwd(), r))
const SKIP_DIRS = new Set(['node_modules', '.next', 'data', '__fixtures__'])
const OLD_STORES = /insights\/store|readStandingPreferences|ingestInsight|searchInsights|upsert_insight|search_insights|distill|strategy_proposal_outcomes|from\(['"]insights['"]\)/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...walk(full))
    } else if (/\.(ts|tsx|md|json)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** The one-time move names the old tables on purpose: it is what reads them. */
const THE_MOVE = 'scripts/learning-move.ts'

describe('the old learning stores are gone before their tables are dropped', () => {
  it('no code, prompt or script names them', () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, 'utf8')
        const rel = path.relative(process.cwd(), file)
        if (rel !== THE_MOVE && OLD_STORES.test(text)) hits.push(rel)
      }
    }
    expect(hits).toEqual([])
  })

  it('the files that held them are deleted', () => {
    for (const gone of ['lib/insights/store.ts', 'lib/graph/distill.ts', 'prompts/memory_extract.md', 'prompts/distill.md']) {
      expect(() => statSync(path.resolve(process.cwd(), gone)), gone).toThrow()
    }
  })
})
