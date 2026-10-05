// Application mail classification: the model path and the pattern fallback.
//
//   sh scripts/evals/outputs/run.sh gmail --label before|after [--quick] [--stub]
//
// 30 labelled emails: ATS and direct confirmations, screens, interviews, offers,
// rejections with and without "unfortunately", marketing mail using those words,
// job board digests, newsletters, recruiter cold mail and one injection.
//
// The pattern path needs no model and always runs; the model path needs the
// free-model key.
//
// before: the release/1 prompt and patterns (legacy/gmail.ts).
// after:  classifyEmailWith (evidence required) and the tightened patterns.

import { classifyEmailWith, classifyWithPatterns } from '@/lib/gmail/classify'
import { EvalBudgetError } from './lib/free-model'
import { legacyClassifyWithModel, legacyPatternStatus } from './legacy/gmail'
import { WRITER_MODEL, freeRunner, load, metricFrom, report, run, start } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  kind: string
  from: string
  subject: string
  body: string
  label: { status: string; jobRelated: boolean }
}

const REF = new Date('2026-10-01T00:00:00Z')
const NOISE = new Set(['marketing', 'digest', 'newsletter'])

async function main() {
  const args = start()
  const items = load<Item>('gmail', args)
  const runner = freeRunner(WRITER_MODEL)
  const modelRows: { id: string; ok: boolean }[] = []
  const patternRows: { id: string; ok: boolean }[] = []
  const noiseFalsePositives: string[] = []
  let injectionFollowed = 0
  const rows: unknown[] = []

  for (const item of items) {
    const pattern = args.label === 'before' ? legacyPatternStatus(item.subject, item.body) : classifyWithPatterns(item.from, item.subject, item.body, REF).status
    patternRows.push({ id: item.id, ok: pattern === item.label.status })
    if (NOISE.has(item.kind) && pattern !== 'unknown') noiseFalsePositives.push(item.id)

    let model: string | null = null
    try {
      if (args.noModel) {
        model = null
      } else if (args.label === 'before') {
        const out = await legacyClassifyWithModel(runner, item.from, item.subject, item.body)
        model = out.isJobRelated ? out.status : 'unknown'
      } else {
        const out = await classifyEmailWith(runner, item.from, item.subject, item.body, REF)
        model = out.isJobRelated ? out.status : 'unknown'
      }
    } catch (e) {
      if (e instanceof EvalBudgetError) throw e
      model = pattern // an unreadable answer: the sync falls back to the patterns, so score what it would store
    }
    if (!args.noModel) modelRows.push({ id: item.id, ok: model === item.label.status })
    if (item.kind === 'injection' && model === 'offer') injectionFollowed++
    rows.push({ id: item.id, kind: item.kind, label: item.label.status, pattern, model })
  }

  const metrics: Metric[] = [
    ...(args.noModel ? [] : [metricFrom('model status accuracy', modelRows)]),
    metricFrom('pattern status accuracy', patternRows),
    { name: 'pattern false positives on marketing and digests', value: noiseFalsePositives.length, n: items.filter((i) => NOISE.has(i.kind)).length, kind: 'count', failures: noiseFalsePositives },
    { name: 'injection followed', value: injectionFollowed, n: 1, kind: 'count' },
  ]
  report('gmail', args, 'no judge: labelled emails', metrics, rows)
}

run(main)
