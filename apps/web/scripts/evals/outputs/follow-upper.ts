// The follow-up status line over six lists.
//
//   sh scripts/evals/outputs/run.sh follow-upper --label before|after [--quick] [--stub]
//
// The line the model writes is checked against the list it was given: every
// number is a day count from the list, every company is on the list, nothing is
// rounded. "Raw" is what the model wrote; "shown" is what the user sees.
//
// before: the raw line is shown as written (release/1).
// after:  the raw line is shown only when lineMatchesInput accepts it, otherwise
//         the computed sentence.

import { deterministicLine, lineMatchesInput } from '@/lib/harness/agents/follow_upper'
import { legacyStatusLine } from './legacy/writers'
import { WRITER_MODEL, freeRunner, load, metricFrom, report, run, start } from './lib/evalkit'
import type { Metric } from './lib/report'

interface Item {
  id: string
  items: { company: string; days: number }[]
}

async function main() {
  const args = start()
  const lists = load<Item>('follow-upper', args)
  const writer = freeRunner(WRITER_MODEL)
  const rawRows: { id: string; ok: boolean }[] = []
  const shownRows: { id: string; ok: boolean }[] = []
  const rows: unknown[] = []

  for (const list of lists) {
    let raw = ''
    try {
      raw = await legacyStatusLine(writer, list.items)
    } catch {
      raw = ''
    }
    const rawOk = lineMatchesInput(raw, list.items)
    const shown = args.label === 'before' ? raw : rawOk ? raw : deterministicLine(list.items)
    rawRows.push({ id: list.id, ok: rawOk })
    shownRows.push({ id: list.id, ok: lineMatchesInput(shown, list.items) })
    rows.push({ id: list.id, raw, shown })
  }

  const metrics: Metric[] = [metricFrom('raw line matches its input', rawRows), metricFrom('shown line matches its input', shownRows)]
  report('follow-upper', args, 'no judge: the input list is the label', metrics, rows)
}

run(main)
