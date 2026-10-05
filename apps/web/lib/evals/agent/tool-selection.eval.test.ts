// Tool selection: what the agent does first with 30 messages, on three free models, majority per case.
//
// OPT-IN, LIVE. It calls free OpenRouter models (never a paid one: lib/evals/agent/free.eval.ts refuses any id
// that does not end in ":free"). Without RUN_AGENT_EVALS=1 it reports skipped, which is the default.
//
//   cd apps/web
//   RUN_AGENT_EVALS=1 AGENT_EVAL_MODE=old   nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/tool-selection.eval.test.ts
//   RUN_AGENT_EVALS=1 AGENT_EVAL_MODE=new   nice -n 19 ./node_modules/.bin/vitest run lib/evals/agent/tool-selection.eval.test.ts
//
// MODE old scores the earlier Copilot (its prompt and its 19 tools) on the same messages; new scores the real
// orchestrator (its prompt, 12 tools, skills and subagents). AGENT_EVAL_QUICK=1 runs 10 cases on one model.
// AGENT_EVAL_LABEL names the run in its report. Reports go to ~/cello-scratch/evals/agent.
// The key is read from OPENROUTER_API_KEY or ~/.cello-secrets.env and is never printed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERATORS, mapByModel, pct, RUN_LIVE, stats, writeReport } from './free.eval'
import { firstAction, oldFirstAction } from './run'
import { passesNew, passesOld, tally, type CaseSpec } from './score'

const thresholds = JSON.parse(readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8')).tool_selection as { overall: number; delegation: number }
const all = JSON.parse(readFileSync(path.join(__dirname, 'tool-selection.cases.json'), 'utf8')).cases as CaseSpec[]
const QUICK = process.env.AGENT_EVAL_QUICK === '1'
const MODE = (process.env.AGENT_EVAL_MODE ?? 'new') as 'old' | 'new'
const LABEL = process.env.AGENT_EVAL_LABEL ?? (MODE === 'old' ? 'before' : 'after')
const cases = QUICK ? all.filter((_, i) => i % 3 === 0) : all
const models = QUICK ? [GENERATORS[0]] : [...GENERATORS]

describe.skipIf(!RUN_LIVE)(`tool selection (${MODE}, ${LABEL})`, () => {
  it(
    `scores ${cases.length} cases on ${models.length} free model(s)`,
    async () => {
      const jobs = cases.flatMap((spec) => models.map((model) => ({ spec, model })))
      const results = await mapByModel(jobs, (j) => j.model, async ({ spec, model }) => {
        try {
          if (MODE === 'old') {
            const out = await oldFirstAction(model, spec.message)
            return { id: spec.id, model, pass: passesOld(spec, out.action), saw: out.action }
          }
          const out = await firstAction(model, spec.message)
          return { id: spec.id, model, pass: passesNew(spec, out.calls), saw: out.calls.length ? out.calls.map((c) => c.name + (c.name === 'read_file' ? `:${String(c.args.file_path ?? '')}` : '')).join(', ') : 'answer' }
        } catch (e) {
          // A provider failure is a missing measurement, not a wrong answer: it is reported and the model has no vote on that case.
          return { id: spec.id, model, pass: false, saw: `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }
        }
      })

      const rows = cases.map((spec) => ({
        id: spec.id,
        category: spec.category,
        message: spec.message,
        allowed: MODE === 'old' ? spec.allowed_old : spec.allowed_new,
        byModel: Object.fromEntries(results.filter((r) => r.id === spec.id && !r.saw.startsWith('error:')).map((r) => [r.model, r.pass])),
        saw: Object.fromEntries(results.filter((r) => r.id === spec.id).map((r) => [r.model, r.saw])),
      }))
      const t = tally(rows)
      const errors = results.filter((r) => r.saw.startsWith('error:')).length
      const md = [
        `# Tool selection: ${MODE} (${LABEL})`,
        '',
        `Cases: ${t.cases}. Models: ${models.join(', ')}. Provider errors (no vote on that case): ${errors}.`,
        '',
        `| | overall | delegation | single |`,
        `|---|---|---|---|`,
        `| majority | ${pct(Math.round(t.overall * t.cases), t.cases)} | ${(t.delegation * 100).toFixed(0)}% | ${(t.single * 100).toFixed(0)}% |`,
        ...Object.entries(t.perModel).map(([m, v]) => `| ${m} | ${(v * 100).toFixed(0)}% | | |`),
        '',
        '| case | message | models passed | saw |',
        '|---|---|---|---|',
        ...rows.map((r) => `| ${r.id} | ${r.message.slice(0, 60)} | ${Object.values(r.byModel).filter(Boolean).length}/${Object.keys(r.byModel).length} | ${Object.entries(r.saw).map(([m, s]) => `${m.split('/')[1].split(':')[0]}: ${s}`).join(' ; ')} |`),
      ].join('\n')
      const paths = writeReport(`tool-selection-${MODE}-${LABEL}`, { mode: MODE, label: LABEL, models, tally: t, rows }, md)
      console.log(`\n${md}\n\nrequests: ${JSON.stringify(stats)}\nreport: ${paths.md}`)

      if (MODE === 'new' && !QUICK && process.env.AGENT_EVAL_GATE !== '0') {
        expect(t.overall, 'overall majority score').toBeGreaterThanOrEqual(thresholds.overall)
        expect(t.delegation, 'delegation majority score').toBeGreaterThanOrEqual(thresholds.delegation)
      }
    },
    3_600_000
  )
})
