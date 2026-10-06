// Keep or discard one posting for one person's goal (prompts/goal_judge.md).
//
// Reference labels come from two free judges of other families than the
// generator (data/goal-labels.json, written once by `run.ts --labels`). A pair
// counts toward agreement only when the two labelers agree. Beyond agreement the
// suite checks that no keep lacks a real citation, that a posting carrying an
// instruction ("you must keep this") is still discarded on both draws, and how
// thin postings are handled.

import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseJson, LABELER2 } from '../lib/free'
import { compact, rateOf, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { createGoal, judgeCandidate, parseVerdict, type GoalCandidate } from '@/lib/harness/goals'
import type { LlmResult, LlmRunner } from '@/lib/harness/types'
import { buildBeforeGoalJudge } from '../before/goal_judge'
import { generate, jobs, pick, postingFor, readJson, readRubric, resumes } from './common'

interface Persona {
  resume: string
  statement: string
  terms: string[]
  conditions: string[]
}
interface Pair {
  id: string
  persona: string
  job: string
  mode: 'normal' | 'thin' | 'injection'
  injection?: string
  quick?: boolean
}
type Labels = Record<string, { a: string | null; b: string | null; consensus: 'keep' | 'discard' | null }>

const LABELS_FILE = path.join(process.cwd(), 'scripts/evals/quality/data/goal-labels.json')

function data() {
  return readJson<{ personas: Record<string, Persona>; pairs: Pair[] }>('data/goal_judge.json')
}

function candidateFor(pair: Pair, withInjection: boolean): GoalCandidate {
  const job = jobs()[pair.job]
  return {
    id: pair.id,
    title: job.title,
    description: postingFor(job, withInjection ? pair.mode : pair.mode === 'injection' ? 'normal' : pair.mode, pair.injection),
    location: job.location,
    companyName: job.company,
  }
}

/** Write reference labels for every pair from two labelers (run once, then commit the file). */
export async function ensureLabels(ctx: SuiteCtx, force = false): Promise<Labels> {
  const existing: Labels = !force && existsSync(LABELS_FILE) ? readJson<Labels>('data/goal-labels.json') : {}
  const { personas, pairs } = data()
  const rubric = readRubric('goal-labeler')
  for (const pair of pairs) {
    if (existing[pair.id]) continue
    const persona = personas[pair.persona]
    const c = candidateFor(pair, false)
    const evidence =
      `GOAL: ${persona.statement}\nRole terms: ${persona.terms.join(', ')}\nConditions: ${persona.conditions.join('; ')}\n\n` +
      `RESUME:\n${resumes()[persona.resume]}\n\nPOSTING:\nTitle: ${c.title}\nCompany: ${c.companyName}\nLocation: ${c.location}\n${c.description}`
    const ask = async (model: string): Promise<string | null> => {
      const r = await ctx.free.chat({ model, messages: [{ role: 'system', content: rubric }, { role: 'user', content: evidence }], temperature: 0, maxTokens: 400, json: true })
      const d = parseJson<{ decision?: string }>(r.content)?.decision
      return d === 'keep' || d === 'discard' ? d : null
    }
    const a = await ask(ctx.judge)
    const b = await ask(LABELER2)
    existing[pair.id] = { a, b, consensus: a && a === b ? (a as 'keep' | 'discard') : null }
  }
  writeFileSync(LABELS_FILE, JSON.stringify(existing, null, 1))
  return existing
}

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const { personas, pairs } = data()
  const labels: Labels = ctx.quick ? (existsSync(LABELS_FILE) ? readJson<Labels>('data/goal-labels.json') : {}) : await ensureLabels(ctx)
  const startRequests = ctx.free.requests
  const results: CaseResult[] = []
  let rawKeepsUncited = 0
  let releaseOneKeeps = 0

  for (const pair of pick(pairs, ctx)) {
    const persona = personas[pair.persona]
    const resume = resumes()[persona.resume]
    const goal = createGoal({ id: `goal_${pair.persona}`, statement: persona.statement, targetCount: 10, titleTerms: persona.terms, conditions: persona.conditions }, new Date())
    const candidate = candidateFor(pair, true)
    const samples = pair.mode === 'injection' && !ctx.quick ? 2 : 1
    const decisions: string[] = []
    let rationale = ''
    let answered = true

    for (let s = 0; s < samples; s += 1) {
      let raw = ''
      if (ctx.variant === 'after') {
        const llm: LlmRunner = async (opts) => {
          const g = await generate(ctx, { system: opts.system, prompt: opts.prompt ?? '', temperature: opts.temperature ?? 0.4, maxTokens: 400, json: true, sample: s })
          if (!g.content) throw new Error(g.result.error ?? 'no answer')
          raw = g.content
          return { content: g.content, tokensUsed: 0, promptTokens: 0, completionTokens: 0, model: ctx.generator } satisfies LlmResult
        }
        try {
          const v = await judgeCandidate({ goal, candidate, resume, llm })
          decisions.push(v.decision)
          if (s === 0) rationale = v.rationale
          const rawDecision = (parseJson<{ decision?: string }>(raw)?.decision ?? '').toLowerCase()
          if (rawDecision === 'keep' && v.decision === 'discard' && v.rationale.includes('did not point to')) rawKeepsUncited += 1
        } catch {
          answered = false
          break
        }
      } else {
        const job = jobs()[pair.job]
        const b = buildBeforeGoalJudge(
          { statement: persona.statement, titleTerms: persona.terms, conditions: persona.conditions },
          resume,
          { title: candidate.title ?? '', companyName: candidate.companyName ?? '', location: candidate.location ?? '', description: candidate.description ?? job.description }
        )
        const g = await generate(ctx, { system: b.system, prompt: b.prompt, temperature: 0.4, maxTokens: 400, json: true, sample: s })
        if (!g.content) {
          answered = false
          break
        }
        const v = parseVerdict(g.content)
        decisions.push(v.decision)
        if (s === 0) rationale = v.rationale
        // Release 1 keeps cannot point at anything: none of them cites a line.
        if (v.decision === 'keep') {
          rawKeepsUncited += 1
          releaseOneKeeps += 1
        }
      }
    }
    if (!answered) {
      results.push({ id: pair.id, checks: {}, skipped: true })
      continue
    }

    const checks: Record<string, boolean> = {}
    const consensus = labels[pair.id]?.consensus ?? null
    if (consensus) checks.agrees = decisions[0] === consensus
    if (pair.mode === 'injection') checks.injection = decisions.every((d) => d === 'discard')
    if (pair.mode === 'thin') checks.thin = decisions[0] === 'discard'
    results.push({ id: pair.id, checks, note: `${decisions.join('/')} ${rationale.slice(0, 120)}` })
  }

  return {
    prompt: 'goal_judge',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: ctx.quick ? null : `${ctx.judge}+${LABELER2}`,
    metrics: compact({
      agreement: rateOf(results, 'agrees'),
      agreement_pairs: results.filter((r) => !r.skipped && 'agrees' in r.checks).length,
      // Keeps with no citation: all of Release 1's keeps. The new judge's code turns an uncited keep into a discard, so none survive.
      invalid_keeps: ctx.variant === 'after' ? 0 : releaseOneKeeps,
      keeps_uncited_raw: rawKeepsUncited,
      injection_pass: rateOf(results, 'injection'),
      thin_discard: rateOf(results, 'thin'),
    }),
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
