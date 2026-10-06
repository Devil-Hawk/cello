// Guards the invariant spend.ts states about itself: that the monthly cap is
// enforced at EVERY path which can reach a model.
//
// WHY THIS FILE EXISTS
//   spend.ts's header says the cap is "enforced at the single LLM choke point",
//   and that was true while lib/harness/llm.ts's callLlm was the only way to
//   reach a provider: reserveSpend and settleSpend live there, so every
//   metered feature inherits them for free. (They replaced the old
//   check-then-charge pair, which let N parallel calls all pass the check.)
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
//
// A SECOND, RUNTIME SIGNAL FOR THE SAME BUG (Step 2, lib/trace/spans.ts):
//   callLlm now emits a trace_spans 'llm' span for every call that carries a
//   userId — metered or not (see lib/harness/llm.test.ts's "emits an llm
//   span" describe block). A model call that reaches a provider through some
//   NEW bypass this file's static scan doesn't yet know to look for still
//   leaves no trace_spans row behind it, exactly like it leaves no spend row
//   behind it — an operator staring at trace_spans for a user with model
//   activity elsewhere in the product (an application drafted, an email
//   sent) and no corresponding spans is looking at the same bypass this file
//   exists to catch at review time. Not a new automated check this stage —
//   the source scan above stays the enforced guarantee — just the same
//   invariant now visible two ways instead of one.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const API_ROOT = path.resolve(process.cwd(), 'app/api')

// The LangGraph port (docs/superpowers/specs/2026-08-16-langgraph-port-
// design.md) adds lib/graph/invoke.ts and lib/graph/unit.ts as new,
// non-route places that reach a model — invokeGraphForUser and the agent
// unit wrapper both sit outside app/api. lib/graph/* is folded into this
// same walk below, scoped to just that directory (not all of lib): lib/
// harness/providers/* legitimately construct their own `new OpenAI(`
// clients as callLlm's OWN internals, and scanning all of lib here would
// flag a guard that already lives one level up in callLlm itself — the
// same false positive spend-chokepoints was written to AVOID, not cause.
// No new markers yet: the unit wrapper's own CALL_LLM_WRAPPERS entry lands
// with the wrapper (stage 1's lib/graph/unit.ts), so this only widens the
// walk ahead of time — it stays a no-op until that file exists.
const GRAPH_ROOT = path.resolve(process.cwd(), 'lib/graph')

// Everything else that can reach a model is scanned too. lib/harness itself is
// excluded: callLlm, callEmbedding and the providers are the chokepoint's own
// internals and are pinned by name below.
const EXTRA_ROOTS = ['lib/evals', 'lib/scoring', 'lib/agents', 'lib/outreach', 'lib/gmail', 'lib/resume', 'lib/jobs'].map((r) =>
  path.resolve(process.cwd(), r)
)

// Step 7's MemoryStore (lib/memory/mem0-store.ts) is a THIRD non-route place
// that reaches a model: its 'langchain' LLM/embedder delegates call callLlm/
// callEmbedding directly (see that file's own header), so a caller that
// reached a model only by going through getMemoryStore().add/search would be
// invisible to this scan without folding lib/memory in too — same reasoning
// as GRAPH_ROOT above, same narrow scope (not all of lib).
const MEMORY_ROOT = path.resolve(process.cwd(), 'lib/memory')

function walk(dir: string, keep: (name: string) => boolean = (name) => name === 'route.ts'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (keep(entry)) out.push(full)
  }
  return out
}

/**
 * Ways a route can reach a model WITHOUT going through callLlm, and therefore
 * without inheriting the budget guards. Extend this list when a new provider
 * path appears — that is the moment the guarantee is most at risk.
 */
const DIRECT_MODEL_CLIENT_MARKERS = [
  'new OpenAI(', // a hand-rolled client
  // A raw fetch/URL to an embeddings endpoint, bypassing callEmbedding.
  // MUTATION CHECK (executed, not left to trust): added a scratch
  // app/api/_mutation_scratch/route.ts that fetched
  // 'https://openrouter.ai/api/v1/embeddings' directly with no budget guard —
  // this exact `it.each` case went red, naming the scratch file as an
  // offender. Deleted immediately.
  '/embeddings',
  // A raw fetch to a chat endpoint, or a hand-rolled Anthropic/LangChain client.
  'chat/completions',
  'api.anthropic.com',
  'new Anthropic(',
  'ChatOpenRouter(',
]

/**
 * Routes that reach a provider WITHOUT the Cello ledger because they spend the
 * USER'S OWN key (their Anthropic or OpenAI account), not Cello's OpenRouter
 * credit. A demo can only hold the openrouter provider (lib/access/guardrails.ts),
 * so nothing here can spend an owner's money. Adding a file here is a decision:
 * say whose key it spends.
 */
const ALLOWED_DIRECT_USER_KEY: Record<string, string> = {
  'app/api/scraper/trigger/route.ts': "user's own OpenAI/Anthropic key",
  'app/api/resume/upload/route.ts': "user's own Anthropic/OpenAI key",
}

/**
 * Callers that reach a model THROUGH callLlm, where the guards already live —
 * but only if they hand callLlm a user id.
 *
 * THIS LIST EXISTS BECAUSE THE ONE ABOVE MISSED A REAL BUG.
 *   callLlm enforces the cap conditionally:
 *       const metered = provider === 'openrouter' && Boolean(apiKeys.userId)
 *   lib/outreach/llm.ts's makeLlmRunner called it as
 *   `callLlm({ openrouter: key }, opts)` — no userId — so `metered` was false
 *   and BOTH assertWithinBudget and recordSpend were skipped. Two shipped
 *   routes, /api/outreach/draft and /api/outreach/follow-up, called a real
 *   model on every request while the ledger never moved.
 *
 *   The marker list above could never have caught it: those routes build no
 *   client of their own, so they match neither marker. The invariant was
 *   "every path to a model is behind the cap", but the test only knew how to
 *   look for ONE way of reaching a model. This second list covers the other
 *   way — going through callLlm with metering accidentally switched off.
 *
 *   Extend this whenever a new helper wraps callLlm.
 *
 * makeLlmRunner ENTRY RETIRED AS OF THE LANGGRAPH PORT (step 9): it's
 * deleted — lib/outreach/llm.ts is gone, and /api/outreach/draft +
 * /api/outreach/follow-up now reach a model through
 * lib/graph/unit.ts#runAgentUnit, which builds its OWN fresh, metered
 * LlmRunner per call and throws MissingUserIdError rather than build an
 * unmetered one (see the pinning test below, which replaces "makeLlmRunner
 * itself refuses..." for the same reason). MUTATION CHECK (documented, not
 * left to trust): temporarily re-added a `makeLlmRunner(key)` (no userId)
 * call to a scratch file under app/api/ with `CALL_LLM_WRAPPERS =
 * ['makeLlmRunner(']` restored — the `it.each(CALL_LLM_WRAPPERS)` case went
 * red on that file exactly as it did historically; reverted immediately.
 *
 * meteredJudgeClient ENTRY, STEP 3 (rewards/tracing): buildJudgeClient used
 * to sit in DIRECT_MODEL_CLIENT_MARKERS above instead — it needed the
 * calling ROUTE to also carry assertWithinBudget/recordSpend text, because
 * the client itself did neither. meteredJudgeClient now metres its own
 * requests (see lib/evals/judge.ts's meteredFetch, proven by
 * lib/evals/judge.test.ts), so it belongs HERE, next to callLlm, not there:
 * the caller only needs to hand it a userId, exactly like callLlm's own
 * apiKeys.userId. The old buildJudgeClient marker was deleted from the list
 * above in this same commit rather than left to match nothing forever.
 *
 * MUTATION CHECK (executed, not left to trust): changed
 * app/api/outreach/judge/route.ts's `meteredJudgeClient(admin, user.id,
 * apiKeys)` call to `meteredJudgeClient(admin)` — this exact `it.each` case
 * went red, naming that route as an offender ("pass no user id... spend
 * never reaches the ledger"). Reverted immediately.
 */
const CALL_LLM_WRAPPERS: string[] = ['meteredJudgeClient(']

describe('every path to a model is behind the spend cap', () => {
  const graphFiles = existsSync(GRAPH_ROOT)
    ? walk(GRAPH_ROOT, (name) => name.endsWith('.ts') && !name.includes('.test.'))
    : []
  const memoryFiles = existsSync(MEMORY_ROOT)
    ? walk(MEMORY_ROOT, (name) => name.endsWith('.ts') && !name.includes('.test.'))
    : []
  const extraFiles = EXTRA_ROOTS.filter((r) => existsSync(r)).flatMap((r) =>
    walk(r, (name) => name.endsWith('.ts') && !name.includes('.test.'))
  )
  // Non-route modules under app/api (helpers) are scanned as well as route.ts.
  const apiFiles = walk(API_ROOT, (name) => name.endsWith('.ts') && !name.includes('.test.'))
  const routes = [...apiFiles, ...graphFiles, ...memoryFiles, ...extraFiles]

  it('finds routes to check (guards against a broken walk silently passing)', () => {
    expect(routes.length).toBeGreaterThan(20)
  })

  it.each(DIRECT_MODEL_CLIENT_MARKERS)(
    'every file using %s also calls reserveSpend and settleSpend, or is an allowed own-key path',
    (marker) => {
      const offenders: string[] = []
      for (const file of routes) {
        const src = readFileSync(file, 'utf8')
        if (!src.includes(marker)) continue
        const rel = path.relative(process.cwd(), file)
        if (rel in ALLOWED_DIRECT_USER_KEY) continue
        const guarded = src.includes('reserveSpend(') && src.includes('settleSpend(')
        if (!guarded) offenders.push(rel)
      }
      expect(
        offenders,
        `These files build their own model client but skip the spend reservation, so ` +
          `they spend outside the monthly cap and never reach the ledger:\n  ${offenders.join('\n  ')}`
      ).toEqual([])
    }
  )

  it('the allowed own-key files exist and name their reason', () => {
    for (const [rel, reason] of Object.entries(ALLOWED_DIRECT_USER_KEY)) {
      expect(existsSync(path.resolve(process.cwd(), rel)), `${rel} is allowlisted but missing; delete the entry`).toBe(true)
      expect(reason.length).toBeGreaterThan(0)
    }
  })

  it('the old check-then-charge helpers are gone: a charge without a reservation cannot be written', () => {
    const offenders: string[] = []
    for (const root of ['lib', 'app']) {
      for (const file of walk(path.resolve(process.cwd(), root), (name) => /\.tsx?$/.test(name) && !name.includes('.test.'))) {
        const src = readFileSync(file, 'utf8')
        // Code, not comments: a call, an import or an rpc name.
        if (/\brecordSpend\(|\brecord_llm_spend\b|import\s*{[^}]*\brecordSpend\b/.test(src.replace(/\/\/.*$/gm, ''))) {
          offenders.push(path.relative(process.cwd(), file))
        }
      }
    }
    expect(offenders, `recordSpend / record_llm_spend must not come back:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('the engine spend middleware, when present, reserves and settles', () => {
    const middleware = path.join(process.cwd(), 'lib/agents/middleware.ts')
    if (!existsSync(middleware)) return
    const src = readFileSync(middleware, 'utf8')
    expect(src).toContain('reserveSpend(')
    expect(src).toContain('settleSpend(')
  })

  it.each(CALL_LLM_WRAPPERS)(
    'every route calling %s passes a user id, so callLlm actually meters',
    (marker) => {
      const offenders: string[] = []
      for (const file of routes) {
        const src = readFileSync(file, 'utf8')
        if (!src.includes(marker)) continue
        // The call must carry a second argument. `makeLlmRunner(config.key)` is
        // the unmetered shape; `makeLlmRunner(config.key, user.id)` is not.
        const calls = src.split(marker).slice(1)
        const unmetered = calls.some((tail) => {
          const args = tail.slice(0, tail.indexOf(')'))
          return !args.includes(',')
        })
        if (unmetered) offenders.push(path.relative(process.cwd(), file))
      }
      expect(
        offenders,
        `These routes reach a model through callLlm but pass no user id, so callLlm's ` +
          `own cap check (metered = provider === 'openrouter' && Boolean(apiKeys.userId)) ` +
          `silently switches itself off and the spend never reaches the ledger:\n  ${offenders.join('\n  ')}`
      ).toEqual([])
    }
  )

  it('lib/graph/unit.ts#runAgentUnit itself refuses to build an unmetered/unaudited runner', () => {
    // Same source-level check, same reason, on the graph port's own agent
    // contract (docs/superpowers/specs/2026-08-16-langgraph-port-design.md —
    // "lib/graph/unit.ts#runAgentUnit ... a fresh metered LlmRunner per call
    // (throws without userId)"). A caller that satisfies UnitConfig's type
    // with an empty string would still be unmetered at runtime, exactly the
    // makeLlmRunner failure mode above — so this checks the VALUE the same way.
    const unitFile = path.join(GRAPH_ROOT, 'unit.ts')
    expect(existsSync(unitFile), 'lib/graph/unit.ts must exist once stage 1 of the port lands').toBe(true)
    const src = readFileSync(unitFile, 'utf8')
    expect(src).toContain('userId')
    expect(src, 'runAgentUnit must throw rather than build an unmetered/unaudited runner').toMatch(
      /if \(!userId\)[\s\S]{0,120}throw/
    )
  })

  it('callEmbedding itself meters exactly like callLlm, per attempt in its fallback chain', () => {
    // callEmbedding (this file) is a FALLBACK CHAIN, not callLlm's single
    // provider pick, so there's no one call site to point CALL_LLM_WRAPPERS
    // at — the guard has to live inside callEmbedding's own loop, once per
    // attempt. Pin the function body directly, same technique as the
    // runAgentUnit check above: read the VALUE, not a claim about it.
    //
    // MUTATION CHECK (executed, not left to trust): replaced the
    // `settleSpend(admin, reservation, ...)` call inside callEmbedding's chain
    // with a comment and ran this test alone: it went red on "expected fnSrc to
    // contain 'settleSpend('". Reverted immediately.
    const llmFile = path.join(process.cwd(), 'lib/harness/llm.ts')
    const src = readFileSync(llmFile, 'utf8')
    const start = src.indexOf('export async function callEmbedding')
    expect(start, 'lib/harness/llm.ts must export callEmbedding').toBeGreaterThan(-1)
    const fnSrc = src.slice(start)
    expect(fnSrc).toContain("provider === 'openrouter' && Boolean(apiKeys.userId)")
    expect(fnSrc).toContain('reserveSpend(')
    expect(fnSrc).toContain('settleSpend(')
  })

  it('callLlm reserves per attempt and settles, and never charges without a reservation', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/harness/llm.ts'), 'utf8')
    const start = src.indexOf('export async function callLlm')
    const end = src.indexOf('export async function callEmbedding')
    const fnSrc = src.slice(start, end)
    expect(fnSrc).toContain('reserveSpend(')
    expect(fnSrc).toContain('settleSpend(')
    expect(fnSrc).toContain('DEFAULT_MAX_TOKENS')
  })

  it('the judge client reserves and settles inside its fetch wrapper', () => {
    const src = readFileSync(path.join(process.cwd(), 'lib/evals/judge.ts'), 'utf8')
    expect(src).toContain('reserveSpend(')
    expect(src).toContain('settleSpend(')
  })

  it('lib/memory/mem0-store.ts never constructs its own provider client or holds a key at module scope', () => {
    // The makeLlmRunner bug in its exact shape, one layer down: mem0's
    // 'langchain' LLM/embedder shim requires an already-built instance at
    // Memory CONSTRUCTION time (see mem0-store.ts's own apiKeysContext
    // comment for the citation), which is exactly the trap that would
    // rebuild the old unmetered-spend bug if this file ever built a real
    // OpenAI/Anthropic client itself instead of a keyless delegate that
    // reads apiKeys per call. Read the VALUE, not a claim about it, same
    // technique as the runAgentUnit pin above.
    //
    // MUTATION CHECK (executed, not left to trust): added a module-scope
    // `const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY })`
    // directly to lib/memory/mem0-store.ts on disk — this exact assertion
    // went red ("expected src not to contain 'new OpenAI('"). Reverted via
    // `git diff` confirming a byte-identical file; nothing of the kind is
    // committed.
    const file = path.join(MEMORY_ROOT, 'mem0-store.ts')
    expect(existsSync(file), 'lib/memory/mem0-store.ts must exist once Step 7 of the port lands').toBe(true)
    const src = readFileSync(file, 'utf8')
    expect(src).not.toContain('new OpenAI(')
    expect(src).not.toContain('new Anthropic(')
    expect(src).not.toMatch(/process\.env\.\w*(KEY|TOKEN|SECRET)\w*/)
    // The one construction site (`new Memory(`) must take a config built
    // fresh from a function call, not a top-level object literal carrying
    // key material — the config-building function is what's allowed to
    // close over the keyless delegates, never the constructor call itself.
    expect(src).toContain('new Memory(buildMemoryConfig())')
  })

  it('the judge route specifically is guarded — it is why this test exists', () => {
    const src = readFileSync(path.join(API_ROOT, 'outreach/judge/route.ts'), 'utf8')
    // A read-only early refusal before any request is built, PLUS the metered
    // client every request actually goes through. Reserving and settling live
    // only inside meteredJudgeClient's fetch wrapper (see that CALL_LLM_
    // WRAPPERS entry above), so this route carries no reserve text of its own;
    // duplicating it here would double-bill the same call.
    expect(src).toContain('assertWithinBudget')
    expect(src).toContain('meteredJudgeClient(')
    // A cap hit is an answer, not a crash: the user is told they are out of
    // allowance rather than shown a generic failure.
    expect(src).toContain('BudgetCapError')
  })
})
