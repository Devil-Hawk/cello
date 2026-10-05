// The outreach judges against hand-labelled drafts.
//
//   sh scripts/evals/outputs/run.sh judges --label before|after [--quick] [--stub]
//
// 12 drafts: 6 grounded, 6 with one plausible claim planted (an invented project,
// a changed number, an upgraded role). 6 drafts for specificity: 3 that carry a
// detail from the job post, 3 that could be sent to anyone.
//
// before: autoevals Factuality at 0.5 and ClosedQA with only "Company, Title"
//         (legacy/judges.ts), on the free production-judge model.
// after:  judgeClaims and judgeSpecificity over the numbered sources, same model.

import { judgeClaims, judgeSpecificity } from '@/lib/evals/claims-judge'
import { jobLines, resumeLines } from '@/lib/resume/lines'
import { legacyGroundedness, legacySpecificity } from './legacy/judges'
import { PRODUCTION_JUDGE_MODEL, freeRunner, job, load, metricFrom, report, resumeText, run, start } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  type: 'claims' | 'specificity'
  resume?: string
  jobId: string
  draft: string
  label: { grounded?: boolean; planted?: string | null; specific?: boolean }
}

async function main() {
  const args = start()
  const items = load<Item>('judges', args)
  const judge = freeRunner(PRODUCTION_JUDGE_MODEL)
  const claimRows: { id: string; ok: boolean }[] = []
  const plantedRows: { id: string; ok: boolean }[] = []
  const specificRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []

  for (const item of items) {
    const j = job(item.jobId)
    if (item.type === 'claims') {
      const resume = resumeText(item.resume!)
      let predictedGrounded: boolean | null
      if (args.label === 'before') {
        const sourceFacts = `Resume: ${resume.trim()}\n\nJob post: ${j.title} at ${j.company}. ${j.description}`
        predictedGrounded = await legacyGroundedness(PRODUCTION_JUDGE_MODEL, item.draft, sourceFacts).then((r) => (r.score === null ? null : r.pass)).catch(() => null)
      } else {
        const r = await judgeClaims(judge, { text: item.draft, sources: [...resumeLines(resume), ...jobLines(j.description)] })
        predictedGrounded = r.verdict === 'insufficient-data' ? null : r.verdict === 'pass'
      }
      const ok = predictedGrounded === item.label.grounded
      claimRows.push({ id: item.id, ok })
      if (item.label.planted) plantedRows.push({ id: item.id, ok: predictedGrounded === false })
      rows.push({ id: item.id, label: item.label.grounded, predicted: predictedGrounded })
    } else {
      let predictedSpecific: boolean | null
      if (args.label === 'before') {
        predictedSpecific = await legacySpecificity(PRODUCTION_JUDGE_MODEL, item.draft, `${j.company}, ${j.title}`).then((r) => (r.score === null ? null : r.pass)).catch(() => null)
      } else {
        const r = await judgeSpecificity(judge, { text: item.draft, jobLines: jobLines(j.description), facts: [], role: j.title, company: j.company })
        predictedSpecific = r.verdict === 'insufficient-data' ? null : r.verdict === 'pass'
      }
      specificRows.push({ id: item.id, ok: predictedSpecific === item.label.specific })
      rows.push({ id: item.id, label: item.label.specific, predicted: predictedSpecific })
    }
  }

  const metrics: Metric[] = [
    metricFrom('claims judge accuracy', claimRows),
    metricFrom('planted claims caught', plantedRows),
    metricFrom('specificity judge accuracy', specificRows),
  ]
  report('judges', args, PRODUCTION_JUDGE_MODEL, metrics, rows)
}

run(main)
