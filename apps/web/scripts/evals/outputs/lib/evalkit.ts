// Shared helpers for the output evals: data loading, the yardstick judge, and
// the standard start-up and shutdown every script goes through.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EvalBudgetError, PRODUCTION_JUDGE_MODEL, WRITER_MODEL, YARDSTICK_MODEL, chat, requireKeyOrSkip, setMaxRequests, setStub } from './free-model'
import { dataDir, finish, parseArgs, readJsonl, type Args, type Metric, type Report } from './report'
import { freeRunner } from './runner'

export const DATA = join(process.cwd(), 'scripts', 'evals', 'outputs', 'data')
export const RUBRICS = join(process.cwd(), 'scripts', 'evals', 'outputs', 'rubrics')

export const resumeText = (file: string): string => readFileSync(join(DATA, 'resumes', file), 'utf8')

export interface Job {
  id: string
  company: string
  title: string
  location: string
  url: string
  description: string
}
let jobCache: Record<string, Job> | null = null
export function job(id: string): Job {
  jobCache ??= Object.fromEntries((JSON.parse(readFileSync(join(DATA, 'jobs.json'), 'utf8')) as Job[]).map((j) => [j.id, j]))
  const found = jobCache[id]
  if (!found) throw new Error(`no job ${id}`)
  return found
}

export { WRITER_MODEL, PRODUCTION_JUDGE_MODEL, YARDSTICK_MODEL, freeRunner, readJsonl, dataDir }
export { metricFrom } from './report'
export type { Args, Metric }

export function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim()
  for (const candidate of [t, t.match(/\{[\s\S]*\}/)?.[0] ?? '']) {
    try {
      const v = JSON.parse(candidate)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // try the next form
    }
  }
  return null
}

/**
 * The yardstick: a judge from a third model family reading a rubric that is kept
 * with the eval scripts and is not the production judge's prompt. Returns null
 * when the answer cannot be read, which callers count as "not judged", never as a pass.
 */
export async function yardstick(rubric: string, input: string): Promise<Record<string, unknown> | null> {
  const system = readFileSync(join(RUBRICS, `${rubric}.md`), 'utf8')
  try {
    const res = await chat({ model: YARDSTICK_MODEL, system, prompt: input, json: true, maxTokens: 1500, temperature: 0 })
    return parseJson(res.content)
  } catch (e) {
    if (e instanceof EvalBudgetError) throw e
    return null
  }
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Standard start-up: parse flags, honour --stub, skip cleanly without a key, cap requests. */
export function start(): Args {
  const args = parseArgs(process.argv.slice(2))
  if (args.stub) setStub('{}')
  else if (!args.noModel) requireKeyOrSkip()
  setMaxRequests(args.maxRequests)
  return args
}

export function load<T>(feature: string, args: Args): T[] {
  return readJsonl<T>(join(dataDir(feature, args), 'items.jsonl'))
}

/** Run a script's main, report a request-cap stop as a partial result, and fail loudly on anything else. */
export function run(main: () => Promise<void>): void {
  main().catch((e) => {
    if (e instanceof EvalBudgetError) {
      console.error(`stopped early: ${e.message}`)
      return
    }
    console.error(e)
    process.exitCode = 2
  })
}

export function report(feature: string, args: Args, judge: string, metrics: Metric[], items?: unknown[]): void {
  const r: Omit<Report, 'at' | 'requests'> = { feature, label: args.stub ? `${args.label}-stub` : args.label, writer: WRITER_MODEL, judge, metrics, items }
  finish(r, args)
}
