// The planner (prompts/planner.md): does a goal become the shortest valid plan,
// with exactly the agent types the goal needs? Scored in code against the plan
// schema and a set of acceptable type sets.

import { parseJson } from '../lib/free'
import { compact, rateOf, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AGENT_CATALOG, EXECUTABLE_AGENT_TYPES } from '@/lib/harness/registry'
import { PlanSchema } from '@/lib/harness/schemas'
import { composeSystemPrompt, getSharedDoc, loadModeDoc } from '@/lib/harness/prompts'
import { generate, pick, readJson } from './common'

interface Case {
  id: string
  goal: string
  expected: string[][]
  needsLoop?: boolean
  quick?: boolean
}

const catalog = `AVAILABLE AGENT TYPES (use ONLY these, never invent one):\n${EXECUTABLE_AGENT_TYPES.map((t) => `- ${t}: ${AGENT_CATALOG[t]}`).join('\n')}`

/** The Release 1 system prompt: shared rules, the old planner document, the catalog. No policy. */
function beforeSystem(): string {
  const old = readFileSync(path.join(process.cwd(), 'scripts/evals/quality/before/planner.md'), 'utf8').trim()
  return [getSharedDoc(), old, catalog].join('\n\n---\n\n')
}

function afterSystem(): string {
  return composeSystemPrompt({ mode: loadModeDoc('planner'), includeVoice: false, stableContext: catalog })
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const { cases } = readJson<{ cases: Case[] }>('data/planner.json')
  const system = ctx.variant === 'before' ? beforeSystem() : afterSystem()
  const results: CaseResult[] = []
  const startRequests = ctx.free.requests

  for (const c of pick(cases, ctx)) {
    const g = await generate(ctx, { system, prompt: `Goal: ${c.goal}`, temperature: 0.2, maxTokens: 2000, json: true })
    if (!g.content) {
      results.push({ id: c.id, checks: {}, skipped: true, note: g.result.error })
      continue
    }
    const raw = parseJson<unknown>(g.content)
    const parsed = PlanSchema.safeParse(raw)
    const checks: Record<string, boolean> = { schema: parsed.success }
    let note: string | undefined
    if (parsed.success) {
      const types = [...new Set(parsed.data.steps.map((s) => s.agent_type as string))]
      checks.setMatch = c.expected.some((e) => sameSet(types, e))
      if (c.needsLoop) {
        checks.loop = parsed.data.steps.some((s) => (s.loop as { until?: { value?: unknown } } | undefined)?.until?.value === 10)
      }
      note = types.join('+')
    } else {
      note = parsed.error.issues.map((i) => i.message).join('; ').slice(0, 160)
    }
    results.push({ id: c.id, checks, note })
  }

  return {
    prompt: 'planner',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: null,
    metrics: compact({ schema: rateOf(results, 'schema'), set_match: rateOf(results, 'setMatch'), loop_when_counted: rateOf(results, 'loop') }),
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
