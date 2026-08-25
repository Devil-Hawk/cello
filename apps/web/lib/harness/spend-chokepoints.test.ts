// Guards the invariant spend.ts states about itself: that the monthly cap is
// enforced at EVERY path which can reach a model.
//
// WHY THIS FILE EXISTS
//   spend.ts's header says the cap is "enforced at the single LLM choke point",
//   and that was true while lib/harness/llm.ts's callLlm was the only way to
//   reach a provider — assertWithinBudget and recordSpend live there, so every
//   metered feature inherited them for free.
//
//   Then /api/outreach/judge shipped. It reaches OpenRouter through autoevals,
//   which needs an OpenAI-compatible client rather than an injectable function,
//   so it could not route through callLlm. That created a SECOND choke point,
//   and it arrived unguarded: a user sitting at their cap could keep clicking
//   the judge, and the spend never entered the ledger — quietly falsifying the
//   remaining-budget figure the dashboard meter, the jobs page hint and the
//   budget editor all read.
//
//   The failure was invisible in review because nothing was wrong with the
//   route in isolation; it only misbehaved relative to a guarantee documented
//   somewhere else. So this test asserts the guarantee ACROSS files: any route
//   that builds a model client of its own must also call the budget guards.
//   It is a source-level check rather than a runtime one because that is what
//   catches the NEXT such route, which is the one nobody is looking at yet.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const API_ROOT = path.resolve(process.cwd(), 'app/api')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/**
 * Ways a route can reach a model WITHOUT going through callLlm, and therefore
 * without inheriting the budget guards. Extend this list when a new provider
 * path appears — that is the moment the guarantee is most at risk.
 */
const DIRECT_MODEL_CLIENT_MARKERS = [
  'buildJudgeClient', // lib/evals/judge.ts -> autoevals -> OpenRouter
  'new OpenAI(', // a hand-rolled client
]

describe('every path to a model is behind the spend cap', () => {
  const routes = walk(API_ROOT)

  it('finds routes to check (guards against a broken walk silently passing)', () => {
    expect(routes.length).toBeGreaterThan(20)
  })

  it.each(DIRECT_MODEL_CLIENT_MARKERS)(
    'every route using %s also calls assertWithinBudget and recordSpend',
    (marker) => {
      const offenders: string[] = []
      for (const file of routes) {
        const src = readFileSync(file, 'utf8')
        if (!src.includes(marker)) continue
        const guarded = src.includes('assertWithinBudget') && src.includes('recordSpend')
        if (!guarded) offenders.push(path.relative(process.cwd(), file))
      }
      expect(
        offenders,
        `These routes build their own model client but skip the budget guards, so ` +
          `they spend outside the monthly cap and never reach the ledger:\n  ${offenders.join('\n  ')}`
      ).toEqual([])
    }
  )

  it('the judge route specifically is guarded — it is why this test exists', () => {
    const src = readFileSync(path.join(API_ROOT, 'outreach/judge/route.ts'), 'utf8')
    expect(src).toContain('assertWithinBudget')
    expect(src).toContain('recordSpend')
    // A cap hit is an answer, not a crash: the user is told they are out of
    // allowance rather than shown a generic failure.
    expect(src).toContain('BudgetCapError')
  })
})
