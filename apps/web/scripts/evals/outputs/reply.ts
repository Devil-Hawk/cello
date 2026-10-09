// Replies to cold outreach: positive, negative, neutral, and what is not a reply.
//
//   sh scripts/evals/outputs/run.sh reply --label before|after [--quick] [--stub]
//
// 14 replies with quoted originals: 4 positive, 3 negative, 3 neutral, 2
// auto-replies, 2 bounces. The pattern path needs no model and always runs.
//
// before: release/1: the job-application patterns on the whole body (quote
//         included), mapped by classifyReply; an auto-reply counted as a reply.
// after:  bounce and auto-reply by code, the quoted original cut off, then
//         reply patterns or the model with a verbatim quote.

import { classifyReplyPatterns, classifyReplyWith, isAutoReply, isBounce, stripQuoted } from '@/lib/outreach/reply-classify'
import { legacyClassifyReply, legacyPatternStatus } from './legacy/gmail'
import { WRITER_MODEL, freeRunner, load, metricFrom, report, run, start } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  label: 'positive' | 'negative' | 'neutral' | 'auto' | 'bounce'
  from: string
  subject: string
  body: string
  headers: { name: string; value: string }[]
}

async function main() {
  const args = start()
  const items = load<Item>('reply', args)
  const runner = freeRunner(WRITER_MODEL)
  const patternRows: { id: string; ok: boolean }[] = []
  const modelRows: { id: string; ok: boolean }[] = []
  const autoRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []

  for (const item of items) {
    let pattern: string
    let model: string
    if (args.label === 'before') {
      pattern = legacyClassifyReply(item.from, item.subject, legacyPatternStatus(item.subject, item.body))
      model = pattern // release/1 had no reply model
    } else if (isBounce(item.from, item.subject)) {
      pattern = model = 'bounce'
    } else if (isAutoReply(item.headers, item.subject)) {
      pattern = model = 'auto' // skipped: not recorded as a reply
    } else {
      const text = stripQuoted(item.body)
      pattern = classifyReplyPatterns(item.subject, text)
      model = args.noModel ? pattern : await classifyReplyWith(runner, item.subject, text)
    }
    patternRows.push({ id: item.id, ok: pattern === item.label })
    if (args.label !== 'before' && !args.noModel) modelRows.push({ id: item.id, ok: model === item.label })
    if (item.label === 'auto') autoRows.push({ id: item.id, ok: pattern === 'auto' })
    rows.push({ id: item.id, label: item.label, pattern, model })
  }

  const metrics: Metric[] = [
    metricFrom('pattern accuracy', patternRows),
    ...(args.label === 'before' || args.noModel ? [] : [metricFrom('model accuracy', modelRows)]),
    metricFrom('auto-replies not counted as replies', autoRows),
  ]
  report('reply', args, 'no judge: labelled replies', metrics, rows)
}

run(main)
