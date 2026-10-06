// Shapes shared by the quality suites, the report files and the threshold check.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FreeClient } from './free'

export type Variant = 'before' | 'after'

export interface SuiteCtx {
  free: FreeClient
  variant: Variant
  /** Three cases per prompt, code checks only, no judge. */
  quick: boolean
  generator: string
  judge: string
}

export interface CaseResult {
  id: string
  /** Named checks: true passed, false failed. */
  checks: Record<string, boolean>
  /** Numbers worth keeping next to the checks (words, counts). */
  values?: Record<string, number>
  note?: string
  /** True when the model never answered (not counted for or against). */
  skipped?: boolean
}

export interface SuiteResult {
  prompt: string
  variant: Variant
  quick: boolean
  generator: string
  judge: string | null
  /** Metric name to number. Names are what thresholds.json refers to. */
  metrics: Record<string, number>
  cases: CaseResult[]
  /** Network requests this suite made (cache hits are free). */
  requests: number
  at: string
}

export function reportDir(): string {
  return process.env.EVAL_REPORT_DIR ?? path.join(process.cwd(), '.cache/evals-quality/reports')
}

export function reportPath(prompt: string, variant: Variant, quick: boolean): string {
  return path.join(reportDir(), `${prompt}-${variant}${quick ? '-quick' : ''}.json`)
}

export function writeReport(result: SuiteResult): string {
  const file = reportPath(result.prompt, result.variant, result.quick)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(result, null, 2))
  return file
}

export function readReport(prompt: string, variant: Variant, quick: boolean): SuiteResult | null {
  const file = reportPath(prompt, variant, quick)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SuiteResult) : null
}

// --- thresholds -----------------------------------------------------------------

export interface Bar {
  min?: number
  max?: number
}
export interface PromptThresholds {
  /** What the full run must reach. */
  full: Record<string, Bar>
  /** What the three-case quick run must reach. Looser: it is a smoke test. */
  quick: Record<string, Bar>
  /** Metrics where the after run must not be worse than the saved before run (higher is better unless listed in lowerIsBetter). */
  notBelowBefore?: string[]
  lowerIsBetter?: string[]
}
export type Thresholds = Record<string, PromptThresholds>

export function loadThresholds(): Thresholds {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'scripts/evals/quality/thresholds.json'), 'utf8')) as Thresholds
}

/** Misses of a result against its bars, as plain sentences. Empty means it passed. */
export function misses(result: SuiteResult, thresholds: PromptThresholds, before?: SuiteResult | null): string[] {
  const out: string[] = []
  const bars = result.quick ? thresholds.quick : thresholds.full
  for (const [metric, bar] of Object.entries(bars)) {
    const value = result.metrics[metric]
    if (value === undefined || Number.isNaN(value)) {
      out.push(`${result.prompt}.${metric}: no value`)
      continue
    }
    if (bar.min !== undefined && value < bar.min) out.push(`${result.prompt}.${metric} is ${value}, needs at least ${bar.min}`)
    if (bar.max !== undefined && value > bar.max) out.push(`${result.prompt}.${metric} is ${value}, needs at most ${bar.max}`)
  }
  if (!result.quick && before) {
    for (const metric of thresholds.notBelowBefore ?? []) {
      const a = result.metrics[metric]
      const b = before.metrics[metric]
      if (a === undefined || b === undefined) continue
      const worse = (thresholds.lowerIsBetter ?? []).includes(metric) ? a > b : a < b
      if (worse) out.push(`${result.prompt}.${metric} is ${a}, worse than before (${b})`)
    }
  }
  return out
}

/** Share of the cases that ran a check which passed it, or undefined when no case ran it (so the metric is left out, not counted as 0 or 1). */
export function rateOf(cases: CaseResult[], name: string): number | undefined {
  const rows = cases.filter((c) => !c.skipped && name in c.checks)
  return rows.length === 0 ? undefined : round(rows.filter((c) => c.checks[name]).length / rows.length)
}

/** The object without its undefined values. */
export function compact<T extends Record<string, number | undefined>>(o: T): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, number>
}

export const round = (n: number, places = 3): number => Math.round(n * 10 ** places) / 10 ** places
export const ratio = (num: number, den: number): number => (den === 0 ? 1 : round(num / den))
