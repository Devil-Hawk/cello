// Harness runtime — dynamic-graph primitives: loop control-flow, fan-out
// control-flow, the "upstream produced nothing" contract, and a best-effort
// dependency-output id auto-fill.
//
// Everything in this file is DELIBERATELY DB-free and LLM-free (no AdminClient,
// no ctx.llm) — it's pure orchestration logic parameterized by callbacks. The
// executor (lib/harness/executor.ts) supplies callbacks that actually touch the
// database and run agents; a test can supply stub callbacks and exercise the
// exact same control flow with no live run. See
// /tmp/cello-work/dynamic-test.ts for that harness.

import { ZodError } from 'zod'
import type { LoopCondition, LoopSpec, FanOutSpec, StepAgentType } from './types'

// --- dot-path + condition evaluation -----------------------------------------

/** Resolve a dot-path into a JSON-ish value. `.length` on an array segment
 *  returns its length (so `{key:"matches.length"}` works without special-casing
 *  every agent's output shape). Returns undefined for any unresolvable path. */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    if (part === 'length' && Array.isArray(cur)) return cur.length
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Evaluate one LoopCondition op. Non-numeric operands on a numeric comparator
 *  (gte/gt/lte/lt) evaluate to false rather than throwing — a loop condition
 *  that can never be satisfied should stop via maxIterations, not crash the run. */
export function evalCondition(actual: unknown, op: LoopCondition['op'], expected: LoopCondition['value']): boolean {
  if (op === 'eq') return actual === expected
  if (op === 'neq') return actual !== expected
  const a = toNumber(actual)
  const b = toNumber(expected)
  if (a === null || b === null) return false
  if (op === 'gte') return a >= b
  if (op === 'gt') return a > b
  if (op === 'lte') return a <= b
  return a < b // 'lt'
}

export function evalLoopCondition(output: unknown, cond: LoopCondition): boolean {
  return evalCondition(getByPath(output, cond.key), cond.op, cond.value)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// --- loop control-flow ---------------------------------------------------

export interface LoopIterationResult<T = unknown> {
  status: 'completed' | 'failed'
  output?: T
  error?: string
  /** Optional token cost passthrough for the caller's own accounting. */
  tokens?: number
}

export type LoopStopReason =
  | 'condition-met'
  | 'max-iterations'
  | 'no-forward-progress'
  | 'iteration-failed'
  | 'aborted'

export interface LoopRunResult<T = unknown> {
  /** 'completed' iff at least one iteration produced usable output. */
  status: 'completed' | 'failed'
  finalOutput: T | null
  iterations: number
  stopReason: LoopStopReason
  totalTokens: number
  history: { iteration: number; status: 'completed' | 'failed'; conditionValue?: unknown }[]
}

const NOT_SET = Symbol('loop-progress-not-set')

/**
 * Drive a loop spec to completion. `runIteration(iteration, previousOutput)` is
 * called for iteration 1..maxIterations (1-based) until `spec.until` holds
 * against the latest output, the caller signals abort (budget/deadline), or two
 * consecutive iterations produce the identical `until.key` value without
 * meeting the condition (no forward progress — this is what makes an
 * unsatisfiable condition terminate instead of spinning to maxIterations
 * silently forever being "fine"; it still stops at maxIterations regardless).
 */
export async function runLoop<T = unknown>(
  spec: LoopSpec,
  runIteration: (iteration: number, previousOutput: T | null) => Promise<LoopIterationResult<T>>,
  opts?: { shouldAbort?: () => boolean }
): Promise<LoopRunResult<T>> {
  let iteration = 0
  let finalOutput: T | null = null
  let totalTokens = 0
  let prevProgressValue: unknown = NOT_SET
  const history: LoopRunResult<T>['history'] = []

  while (iteration < spec.maxIterations) {
    if (opts?.shouldAbort?.()) {
      return {
        status: finalOutput !== null ? 'completed' : 'failed',
        finalOutput,
        iterations: iteration,
        stopReason: 'aborted',
        totalTokens,
        history,
      }
    }

    iteration += 1
    const result = await runIteration(iteration, finalOutput)
    totalTokens += result.tokens ?? 0

    if (result.status === 'failed') {
      history.push({ iteration, status: 'failed' })
      return {
        status: finalOutput !== null ? 'completed' : 'failed',
        finalOutput,
        iterations: iteration,
        stopReason: 'iteration-failed',
        totalTokens,
        history,
      }
    }

    finalOutput = (result.output ?? null) as T | null
    const conditionValue = getByPath(result.output, spec.until.key)
    history.push({ iteration, status: 'completed', conditionValue })

    if (evalCondition(conditionValue, spec.until.op, spec.until.value)) {
      return { status: 'completed', finalOutput, iterations: iteration, stopReason: 'condition-met', totalTokens, history }
    }

    if (prevProgressValue !== NOT_SET && sameValue(conditionValue, prevProgressValue)) {
      return {
        status: 'completed',
        finalOutput,
        iterations: iteration,
        stopReason: 'no-forward-progress',
        totalTokens,
        history,
      }
    }
    prevProgressValue = conditionValue
  }

  return { status: 'completed', finalOutput, iterations: iteration, stopReason: 'max-iterations', totalTokens, history }
}

// --- fan-out control-flow -----------------------------------------------

export interface FanOutChildResult<T = unknown> {
  status: 'completed' | 'failed'
  output?: T
  error?: string
  tokens?: number
}

export interface FanOutRunResult<T = unknown> {
  total: number
  completed: number
  failed: number
  totalTokens: number
  results: (FanOutChildResult<T> & { index: number; item: unknown })[]
}

/**
 * Run `runChild` over `items` with bounded concurrency. A child that throws is
 * caught and recorded as a failed result for THAT index only — siblings keep
 * running (Promise.all over the whole batch would otherwise abort every
 * in-flight child the moment any one throws).
 */
export async function runFanOut<T = unknown>(
  items: unknown[],
  concurrency: number,
  runChild: (item: unknown, index: number) => Promise<FanOutChildResult<T>>
): Promise<FanOutRunResult<T>> {
  const results: FanOutRunResult<T>['results'] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      try {
        const r = await runChild(item, index)
        results[index] = { ...r, index, item }
      } catch (e) {
        results[index] = { status: 'failed', error: e instanceof Error ? e.message : String(e), index, item }
      }
    }
  })
  await Promise.all(workers)
  const completed = results.filter((r) => r.status === 'completed').length
  const totalTokens = results.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
  return { total: results.length, completed, failed: results.length - completed, totalTokens, results }
}

/** Resolve a fanOut spec's item list from the overDep's journaled output. */
export function resolveFanOutItems(spec: FanOutSpec, deps: Record<string, unknown>): { items: unknown[]; emptyReason?: string } {
  const depOutput = deps[spec.overDep]
  const raw = getByPath(depOutput, spec.overKey)
  if (Array.isArray(raw) && raw.length > 0) return { items: raw }
  const upstreamReason = upstreamEmptyReason(spec.overDep, depOutput)
  return {
    items: [],
    emptyReason:
      upstreamReason ?? `dependency "${spec.overDep}" key "${spec.overKey}" has no items to fan out over`,
  }
}

// --- empty-input contract ("upstream produced nothing") -----------------

/**
 * Canonical "did this dependency's (schema-valid, COMPLETED) output actually
 * produce anything usable" check. Recognizes the shared diagnostics
 * convention already used across agent outputs (matcher's `skippedReason`,
 * the executor's own `markSkipped` `{skipped}` shape) plus the well-known
 * "list of ids" output fields (jobIds/topJobIds/matches/enriched/companyIds)
 * being empty with nothing else populated. Returns a human-readable reason or
 * null when the output looks non-empty.
 */
export function upstreamEmptyReason(depLabel: string, output: unknown): string | null {
  if (output == null || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (typeof o.skippedReason === 'string' && o.skippedReason.trim()) {
    return `dependency "${depLabel}" skipped: ${o.skippedReason}`
  }
  if (typeof o.skipped === 'string' && o.skipped.trim()) {
    return `dependency "${depLabel}" was skipped: ${o.skipped}`
  }
  const EMPTY_ARRAY_FIELDS = ['jobIds', 'topJobIds', 'matches', 'enriched', 'companyIds'] as const
  const present = EMPTY_ARRAY_FIELDS.filter((f) => Array.isArray(o[f]))
  if (present.length > 0 && present.every((f) => (o[f] as unknown[]).length === 0)) {
    return `dependency "${depLabel}" produced no items (${present.join(', ')} empty)`
  }
  return null
}

/** First empty-upstream reason found across a step's resolved deps, in
 *  iteration order (which is dependsOn order — Object.entries preserves
 *  insertion order for string keys). */
export function firstEmptyUpstreamReason(deps: Record<string, unknown>): string | null {
  for (const [label, output] of Object.entries(deps)) {
    const reason = upstreamEmptyReason(label, output)
    if (reason) return reason
  }
  return null
}

/** True for a zod validation error — specifically the kind an agent's own
 *  `SomeSchema.parse(ctx.input)` throws when required input is missing. Used
 *  to distinguish "this step never had usable input" (expected, from an empty
 *  upstream — should degrade to a skip) from any other runtime error (a real
 *  bug — should still fail normally). */
export function isSchemaError(e: unknown): boolean {
  return e instanceof ZodError
}

// --- best-effort dependency-output id auto-fill --------------------------

/**
 * Agent types whose PUBLIC input contract (declared in ./schemas.ts) takes a
 * single required id field that, in a multi-step plan, naturally comes from an
 * upstream step's output rather than something the planner could know ahead of
 * time (e.g. cv_tailor's `jobId` — the planner writes the DAG before matcher
 * has run and picked a job). This is metadata ABOUT the declared input
 * contract, not a change to any agent implementation.
 */
export const STEP_ID_FIELD: Partial<Record<StepAgentType, 'jobId' | 'companyId' | 'draftId'>> = {
  cv_tailor: 'jobId',
  applier: 'jobId',
  verifier: 'draftId',
  interview_prep: 'jobId',
  company_researcher: 'companyId',
}

function extractSingularId(output: unknown, field: 'jobId' | 'companyId' | 'draftId'): string | undefined {
  if (output == null || typeof output !== 'object') return undefined
  const o = output as Record<string, unknown>
  if (typeof o[field] === 'string' && o[field]) return o[field] as string
  const plural = o[`${field}s`]
  if (Array.isArray(plural) && typeof plural[0] === 'string') return plural[0] as string
  if (field === 'jobId') {
    if (Array.isArray(o.topJobIds) && typeof o.topJobIds[0] === 'string') return o.topJobIds[0] as string
    const matches = o.matches
    if (Array.isArray(matches) && matches[0] && typeof matches[0] === 'object') {
      const jobId = (matches[0] as Record<string, unknown>).jobId
      if (typeof jobId === 'string') return jobId
    }
  }
  return undefined
}

/**
 * Best-effort fill of a step's declared singular id field from a dependency's
 * output, WITHOUT ever overwriting an explicit value the plan already set.
 * Returns the (possibly unchanged) input to use plus which field(s) got filled
 * (purely informational — callers may log it).
 */
export function autoFillStepInput(
  agentType: StepAgentType,
  staticInput: unknown,
  deps: Record<string, unknown>
): { input: unknown; filled: string[] } {
  const field = STEP_ID_FIELD[agentType]
  const base = (staticInput && typeof staticInput === 'object' ? staticInput : {}) as Record<string, unknown>
  if (!field || (typeof base[field] === 'string' && base[field])) {
    return { input: staticInput, filled: [] }
  }
  for (const output of Object.values(deps)) {
    const id = extractSingularId(output, field)
    if (id) return { input: { ...base, [field]: id }, filled: [field] }
  }
  return { input: staticInput, filled: [] }
}
