// Result reporting for the output evals: one JSON file and a markdown table per
// run, and a nonzero exit when a metric falls below its threshold.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { requestCount } from './free-model'

export interface Metric {
  name: string
  /** 0-1 rate, or a count when `kind` is 'count'. */
  value: number
  /** How many items the value is over. */
  n: number
  kind?: 'rate' | 'count'
  /** Failing item ids, so a miss names something a person can open. */
  failures?: string[]
  note?: string
}

export interface Report {
  feature: string
  label: string
  writer: string
  judge: string
  at: string
  requests: number
  metrics: Metric[]
  items?: unknown[]
}

export interface Args {
  label: string
  quick: boolean
  out: string | null
  maxRequests: number
  data: string | null
  /** Check the plumbing with no network; the numbers mean nothing. */
  stub: boolean
  /** Skip the model paths (mail and replies): the pattern paths still run. */
  noModel: boolean
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  const quick = argv.includes('--quick')
  return {
    label: get('--label') ?? 'after',
    quick,
    out: get('--out'),
    maxRequests: Number(get('--max-requests') ?? (quick ? 40 : 400)),
    data: get('--data'),
    stub: argv.includes('--stub'),
    noModel: argv.includes('--no-model'),
  }
}

export const SCRATCH = join(homedir(), 'cello-scratch', 'evals')

export function dataDir(feature: string, args: Args): string {
  if (args.data) return args.data
  const repoCopy = join(process.cwd(), 'scripts', 'evals', 'outputs', 'data', feature)
  const scratch = join(SCRATCH, feature)
  return args.quick || !existsSync(join(scratch, 'items.jsonl')) ? repoCopy : scratch
}

export function readJsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T)
}

export function rate(passes: boolean[]): number {
  return passes.length ? passes.filter(Boolean).length / passes.length : 0
}

export function metricFrom(name: string, results: { id: string; ok: boolean }[], note?: string): Metric {
  return {
    name,
    value: rate(results.map((r) => r.ok)),
    n: results.length,
    failures: results.filter((r) => !r.ok).map((r) => r.id),
    note,
  }
}

type Thresholds = Record<string, Record<string, number>>

export function finish(report: Omit<Report, 'at' | 'requests'>, args: Args): void {
  const full: Report = { ...report, at: new Date().toISOString(), requests: requestCount() }
  const outDir = args.out ?? join(SCRATCH, report.feature, 'results')
  mkdirSync(outDir, { recursive: true })
  const stamp = full.at.replace(/[:.]/g, '-')
  writeFileSync(join(outDir, `${report.label}-${stamp}.json`), JSON.stringify(full, null, 2))

  const lines = [`## ${report.feature} (${report.label}), writer ${report.writer}, judge ${report.judge}`, '', '| metric | value | n | failing |', '|---|---|---|---|']
  for (const m of full.metrics) {
    const v = m.kind === 'count' ? String(m.value) : `${(m.value * 100).toFixed(0)}%`
    lines.push(`| ${m.name} | ${v} | ${m.n} | ${(m.failures ?? []).slice(0, 6).join(', ')} |`)
  }
  const md = lines.join('\n')
  writeFileSync(join(outDir, `${report.label}-${stamp}.md`), md)
  console.log(md)

  if (report.label.startsWith('before') || report.label.endsWith('-stub')) return
  const file = join(process.cwd(), 'scripts', 'evals', 'outputs', 'thresholds.json')
  if (!existsSync(file)) return
  const t = (JSON.parse(readFileSync(file, 'utf8')) as Thresholds)[report.feature] ?? {}
  const misses = full.metrics.filter((m) => t[m.name] !== undefined && (m.kind === 'count' ? m.value > t[m.name] : m.value < t[m.name]))
  if (misses.length) {
    console.error(`below threshold: ${misses.map((m) => `${m.name} ${m.value} (needs ${t[m.name]})`).join('; ')}`)
    process.exitCode = 1
  }
}
