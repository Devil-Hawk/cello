// One sentence from one statistic (prompts/distill.md): one sentence, both
// counts, no cause, hedged when early, a planted rationale ignored, and a judge
// for claims beyond the counts.

import { compact, rateOf, round, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { buildDistillPrompt, statesCounts, EARLY_TOTAL } from '@/lib/graph/distill'
import { buildBeforeDistill } from '../before/distill'
import { generate, judgeJson, pick, readJson, readRubric } from './common'

interface Case {
  id: string
  metric: string
  dimension: string
  band: string
  positive: number
  negative: number
  rationales: string[]
  injection?: boolean
  forbidden?: string[]
  quick?: boolean
}

const CAUSE = /\b(because|due to|caused by|driven by|as a result of)\b/i
const HEDGE = /\b(early|small sample|so far|too few|few cases|limited|small number)\b/i

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const { cases } = readJson<{ cases: Case[] }>('data/distill.json')
  const rubric = readRubric('distill-judge')
  const results: CaseResult[] = []
  let judged = 0
  let beyond = 0
  const startRequests = ctx.free.requests

  for (const c of pick(cases, ctx)) {
    const total = c.positive + c.negative
    const rationales = c.rationales.map((text, i) => ({ id: `v${i + 1}`, text }))
    const candidate = { metric: c.metric, dimension: c.dimension, band: c.band, positive: c.positive, negative: c.negative, verdictIds: [] as string[] }
    const built = ctx.variant === 'before' ? { ...buildBeforeDistill(candidate, rationales), temperature: 0.4 } : { ...buildDistillPrompt(candidate, rationales), temperature: 0.2 }
    const samples = c.injection && !ctx.quick ? 2 : 1
    const checks: Record<string, boolean> = {}
    let first = ''

    for (let s = 0; s < samples; s += 1) {
      const g = await generate(ctx, { system: built.system, prompt: built.prompt, temperature: built.temperature, maxTokens: 220, sample: s })
      if (!g.content) {
        checks.answered = false
        break
      }
      const text = g.content.trim()
      if (s === 0) {
        first = text
        checks.oneSentence = (text.match(/[.!?](\s|$)/g) ?? []).length <= 1
        checks.bothCounts = statesCounts(text, c.positive, c.negative)
        checks.noCause = !CAUSE.test(text)
        checks.hedgedWhenEarly = total >= EARLY_TOTAL || HEDGE.test(text)
      }
      if (c.forbidden) {
        const clean = c.forbidden.every((f) => !text.toLowerCase().includes(f))
        checks.injection = (checks.injection ?? true) && clean
      }
    }
    if (checks.answered === false) {
      results.push({ id: c.id, checks: {}, skipped: true })
      continue
    }

    if (!ctx.quick && first) {
      const verdict = await judgeJson<{ beyond?: boolean }>(
        ctx,
        rubric,
        `COUNTS: ${c.metric}, ${c.dimension} = ${c.band}: ${c.positive} positive, ${c.negative} negative, total ${total}\n\nSENTENCE:\n${first}`
      )
      if (verdict && typeof verdict.beyond === 'boolean') {
        judged += 1
        if (verdict.beyond) beyond += 1
      }
    }
    results.push({ id: c.id, checks, note: first.slice(0, 160) })
  }

  const counted = results.filter((r) => !r.skipped)
  const code = counted.filter((r) => ['oneSentence', 'bothCounts', 'noCause', 'hedgedWhenEarly'].every((k) => r.checks[k])).length
  return {
    prompt: 'distill',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: ctx.quick ? null : ctx.judge,
    metrics: compact({
      code_pass: round(code / Math.max(1, counted.length)),
      both_counts: rateOf(results, 'bothCounts'),
      no_cause: rateOf(results, 'noCause'),
      injection_pass: rateOf(results, 'injection'),
      judge_ok: ctx.quick ? undefined : round((judged - beyond) / Math.max(1, judged)),
    }),
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
