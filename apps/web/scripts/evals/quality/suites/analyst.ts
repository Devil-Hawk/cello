// Prep notes for a job (prompts/analyst.md): schema, citations, short postings,
// a planted instruction, and whether the notes claim things the resume does not.

import { parseJson } from '../lib/free'
import { compact, rateOf, ratio, round, type CaseResult, type SuiteCtx, type SuiteResult } from '../lib/report'
import { buildAnalystPrompt, parseAnalysis } from '@/lib/harness/agents/analyst'
import { citesSupport, cleanCites } from '@/lib/quality/lines'
import { buildBeforeAnalyst } from '../before/analyst'
import { generate, judgeJson, jobs, pick, postingFor, readJson, readRubric, resumes } from './common'

interface Case {
  id: string
  resume: string
  job: string
  mode: 'normal' | 'thin' | 'injection'
  injection?: string
  forbidden?: string[]
  quick?: boolean
}

interface Raw {
  summary?: unknown
  talkingPoints?: unknown
  companyInsights?: unknown
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const textOf = (item: unknown): string => (typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { text?: unknown }).text ?? '') : '')

export async function run(ctx: SuiteCtx): Promise<SuiteResult> {
  const { cases } = readJson<{ cases: Case[] }>('data/analyst.json')
  const rubric = readRubric('analyst-judge')
  const results: CaseResult[] = []
  let items = 0
  let validItems = 0
  let judgeItems = 0
  let judgeUnsupported = 0
  const startRequests = ctx.free.requests

  for (const c of pick(cases, ctx)) {
    const job = jobs()[c.job]
    const resumeText = resumes()[c.resume]
    const description = postingFor(job, c.mode, c.injection)
    const input = { jobTitle: job.title, jobDescription: description, companyName: job.company, companyNotes: null, resumeText }

    const after = ctx.variant === 'after' ? buildAnalystPrompt(input) : null
    const built = after ? { system: after.system, prompt: after.prompt, temperature: 0.2 } : buildBeforeAnalyst(input)
    const samples = c.mode === 'injection' && !ctx.quick ? 2 : 1
    const checks: Record<string, boolean> = {}
    const values: Record<string, number> = {}
    let kept: string[] = []

    for (let s = 0; s < samples; s += 1) {
      const g = await generate(ctx, { system: built.system, prompt: built.prompt, temperature: built.temperature, maxTokens: 2000, json: true, sample: s })
      if (!g.ok) {
        results.push({ id: c.id, checks: {}, skipped: true, note: g.result.error })
        break
      }
      const raw = parseJson<Raw>(g.content)

      if (s === 0) {
        // Schema: the shape the panel needs (for the new prompt, items that carry text and cites).
        const shaped =
          !!raw && typeof raw.summary === 'string' && ['talkingPoints', 'companyInsights'].every((k) => Array.isArray((raw as Record<string, unknown>)[k]))
        checks.schema = shaped
        // Short postings: no company insights in what the model wrote.
        if (c.mode === 'thin' && raw) {
          checks.thin = arr(raw.companyInsights).length === 0
        }
        if (after && raw) {
          const lines = after.lines
          for (const group of [raw.talkingPoints, raw.companyInsights]) {
            for (const item of arr(group)) {
              items += 1
              const o = item as { text?: unknown; cites?: unknown }
              if (typeof item === 'object' && item && citesSupport(String(o.text ?? ''), cleanCites(o.cites), lines)) validItems += 1
            }
          }
          try {
            const parsed = parseAnalysis(g.content ?? '', lines, after.thin)
            kept = [parsed.summary, ...parsed.talkingPoints]
          } catch {
            checks.schema = false
          }
        } else if (raw) {
          kept = [String(raw.summary ?? ''), ...arr(raw.talkingPoints).map(textOf)].filter(Boolean)
        }
      }

      if (c.mode === 'injection' && c.forbidden) {
        const all = JSON.stringify(raw ?? g.content).toLowerCase()
        const clean = c.forbidden.every((f) => !all.includes(f.toLowerCase()))
        checks.injection = (checks.injection ?? true) && clean
      }
    }
    if (results.length && results[results.length - 1].id === c.id && results[results.length - 1].skipped) continue

    // Judge: which statements about the person does the resume not back?
    if (!ctx.quick && kept.length > 0) {
      const verdict = await judgeJson<{ unsupported?: number[] }>(
        ctx,
        rubric,
        `RESUME:\n${resumeText}\n\nNOTES:\n${kept.map((t, i) => `${i}: ${t}`).join('\n')}`
      )
      if (verdict) {
        const bad = arr(verdict.unsupported).filter((n) => typeof n === 'number' && n >= 0 && n < kept.length).length
        judgeItems += kept.length
        judgeUnsupported += bad
        values.unsupported = bad
        values.judged = kept.length
      }
    }
    results.push({ id: c.id, checks, values })
  }

  return {
    prompt: 'analyst',
    variant: ctx.variant,
    quick: ctx.quick,
    generator: ctx.generator,
    judge: ctx.quick ? null : ctx.judge,
    metrics: compact({
      schema: rateOf(results, 'schema'),
      cites_valid: ctx.variant === 'after' ? ratio(validItems, items) : 0,
      thin_handling: rateOf(results, 'thin'),
      injection_pass: rateOf(results, 'injection'),
      judge_unsupported: ctx.quick ? undefined : judgeItems === 0 ? 0 : round(judgeUnsupported / judgeItems),
    }),
    cases: results,
    requests: ctx.free.requests - startRequests,
    at: new Date().toISOString(),
  }
}
