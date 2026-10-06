// The scorecard as plain text, for `pnpm scorecard` and for a page that wants the same words.
// Sentence case, no em dashes. A failing row says FAILING; a measure with no run says "No run yet".

import type { ScorecardRow, Status } from './scorecard'

const LABEL: Record<Status, string> = { failing: 'FAILING', passing: 'passing', no_run: 'no run' }

const date = (iso: string) => iso.slice(0, 10)

function shortName(name: string, max = 70): string {
  return name.length <= max ? name : `${name.slice(0, max - 3).trimEnd()}...`
}

function latestText(r: ScorecardRow): string {
  if (!r.latest) return 'No run yet'
  const value = r.latest.value === null ? '' : String(Math.round(r.latest.value * 1000) / 1000)
  const sample = r.latest.sampleN ? `, ${r.latest.sampleN} sampled` : ''
  const trend = r.trend ? `, ${r.trend}` : ''
  return `${value || 'no value'} on ${date(r.latest.ranAt)}${sample}${trend}`
}

/** One line per measure, failing first, then what each failing or pinned row has to say. */
export function formatScorecard(rows: ScorecardRow[]): string {
  const failing = rows.filter((r) => r.status === 'failing').length
  const noRun = rows.filter((r) => r.status === 'no_run').length
  const lines: string[] = [`Scorecard: ${rows.length} measures, ${failing} failing, ${noRun} with no run yet.`, '']
  const idWidth = Math.max(3, ...rows.map((r) => r.id.length))
  for (const r of rows) {
    lines.push(`${LABEL[r.status].padEnd(8)} ${r.id.padEnd(idWidth)}  ${shortName(r.name)}`)
    lines.push(`${' '.repeat(9 + idWidth + 2)}bar: ${r.bar}. Latest: ${latestText(r)}.`)
    const note = r.latest?.note
    if (note) lines.push(`${' '.repeat(9 + idWidth + 2)}${note}`)
    if (r.pinned && r.pinned !== note) lines.push(`${' '.repeat(9 + idWidth + 2)}${r.pinned}`)
  }
  return lines.join('\n')
}
