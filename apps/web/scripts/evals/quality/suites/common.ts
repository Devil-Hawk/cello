// Helpers the suites share: data loading, one generator call, one judge call.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseJson, type ChatResult } from '../lib/free'
import type { CaseResult, SuiteCtx } from '../lib/report'

const DIR = path.join(process.cwd(), 'scripts/evals/quality')

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(DIR, rel), 'utf8')) as T
}

export function readRubric(name: string): string {
  return readFileSync(path.join(DIR, 'rubrics', `${name}.md`), 'utf8').trim()
}

export interface Job {
  id: string
  company: string
  title: string
  location: string
  description: string
}

export const resumes = (): Record<string, string> => readJson('data/resumes.json')
export const jobs = (): Record<string, Job> => readJson('data/jobs.json')

/** The posting as a case wants it: whole, cut to 200 characters (thin), or with an instruction planted in it. */
export function postingFor(job: Job, mode: string, injection?: string): string {
  if (mode === 'thin') return job.description.slice(0, 200)
  if (mode === 'injection' && injection) return `${job.description}\n\n${injection}`
  return job.description
}

/** Cases to run: all of them, or the ones marked quick. */
export function pick<T extends { quick?: boolean }>(cases: T[], ctx: SuiteCtx): T[] {
  return ctx.quick ? cases.filter((c) => c.quick) : cases
}

export interface Generated {
  content: string | null
  ok: boolean
  result: ChatResult
}

/** One generator call. A call the model never answered is marked so the case is not counted for or against. */
export async function generate(
  ctx: SuiteCtx,
  args: { system?: string; prompt: string; temperature: number; maxTokens: number; json?: boolean; sample?: number }
): Promise<Generated> {
  const messages = [...(args.system ? [{ role: 'system' as const, content: args.system }] : []), { role: 'user' as const, content: args.prompt }]
  const result = await ctx.free.chat({ model: ctx.generator, messages, temperature: args.temperature, maxTokens: args.maxTokens, json: args.json, sample: args.sample })
  return { content: result.content, ok: result.content !== null, result }
}

/** One judge call: the rubric as system text, the evidence as the user message, JSON back. */
export async function judgeJson<T>(ctx: SuiteCtx, rubric: string, evidence: string): Promise<T | null> {
  const result = await ctx.free.chat({
    model: ctx.judge,
    messages: [
      { role: 'system', content: rubric },
      { role: 'user', content: evidence },
    ],
    temperature: 0,
    maxTokens: 700,
    json: true,
  })
  return parseJson<T>(result.content)
}

/** Count of cases where every named check passed, over the cases the model answered. */
export function passRate(cases: CaseResult[], names?: string[]): { passed: number; total: number } {
  const counted = cases.filter((c) => !c.skipped)
  const passed = counted.filter((c) => (names ?? Object.keys(c.checks)).every((n) => c.checks[n] !== false)).length
  return { passed, total: counted.length }
}

export const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
