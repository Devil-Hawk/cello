// Rung evals: for each model step, how well each rung does its job, measured, and
// written to lib/steps/rungs.json. Default routing uses a rung below R3 only for a
// step whose row passed on the step's current prompt. A step with no eval set is
// written as "not measured" and never routes; it is never written as passing.
//
//   pnpm rungs:eval --step inbox.classify --rung R1,R3     (owner-run, scripts/rungs-eval.ts)
//
// This file is the part CI checks: the steps, their sets, the hash and the freshness
// test. The runner is in scripts/ because it spends the operator's eval key and is
// never a path a person's request can reach.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { LocalRequest } from './local'

export type EvalRung = 'R1' | 'R2' | 'R3'
const ORDER: readonly EvalRung[] = ['R1', 'R2', 'R3']

/** Blueprint 11.2: every model step that has a rung. A step declared elsewhere must be listed. */
export const ALL_STEPS = [
  'requirements',
  'role.type',
  'chance',
  'role.evidence',
  'want',
  'learning.read',
  'writer.draft',
  'reviewer.judge',
  'inbox.classify',
  'inbox.employer',
  'person.memory',
  'profile.pick',
  'answer.category',
  'answer.draft',
  'embed',
  'companies.resolve_name',
  'resume.photo',
  'reader.rendered',
  'research.summary',
  'chat',
] as const

export interface EvalCase {
  id: string
  messages: LocalRequest['messages']
  /** Whatever the set's score() needs to judge the reply: a label, a list. */
  expect?: unknown
}

/** A step's labelled set, committed by the package that owns the step. */
export interface StepSet {
  /** The step's prompt: a change to it makes the measured row stale. */
  prompt: string
  /** The score a rung must reach, 0 to 1. */
  bar: number
  cases(): EvalCase[]
  /** Replies are in case order; null is no reply. */
  score(outputs: Array<string | null>, cases: EvalCase[]): number
}

// ponytail: no step has a committed set on main yet, so every row reads "not
// measured". A step's package adds `STEP_SETS['<id>'] = ...` with its labelled
// fixture (K19's mail set for inbox.classify, K5d's postings for requirements).
export const STEP_SETS: Record<string, StepSet> = {}

export interface RungRow {
  model: string
  cases: number
  score: number
  bar: number
  pass: boolean
}

export interface StepEntry {
  promptHash: string | null
  measuredAt: string | null
  rungs: Partial<Record<EvalRung, RungRow>>
  /** The lowest rung whose row passed. */
  minRung: EvalRung | null
  /** True only when minRung's row passed on the current prompt. */
  route: boolean
}

export interface RungsFile {
  version: 1
  steps: Record<string, StepEntry>
}

export const stepHash = (id: string, set: StepSet): string => createHash('sha256').update(JSON.stringify([id, set.prompt])).digest('hex')

/** The 10-case smoke set Settings > Models > Test runs. The same cases as the eval, no second data set. */
export const smokeCases = (stepId: string, sets: Record<string, StepSet> = STEP_SETS): EvalCase[] => sets[stepId]?.cases().slice(0, 10) ?? []

export function entryFrom(rungs: StepEntry['rungs'], hash: string | null): StepEntry {
  const minRung = ORDER.find((r) => rungs[r]?.pass) ?? null
  return { promptHash: hash, measuredAt: hash ? new Date().toISOString() : null, rungs, minRung, route: minRung !== null }
}

export function readRungs(file = path.resolve(process.cwd(), 'lib/steps/rungs.json')): RungsFile {
  return JSON.parse(readFileSync(file, 'utf8')) as RungsFile
}

/** Ids whose row is out of step with the code: unlisted, missing, unmeasured with a set, or measured on an old prompt. */
export function staleSteps(file: RungsFile, sets: Record<string, StepSet> = STEP_SETS, ids: readonly string[] = ALL_STEPS): string[] {
  const stale = new Set<string>(Object.keys(file.steps).filter((id) => !ids.includes(id)))
  for (const id of ids) {
    const e = file.steps[id]
    const set = sets[id]
    if (!e) stale.add(id)
    else if (set ? e.promptHash !== stepHash(id, set) : e.promptHash !== null || Object.keys(e.rungs).length > 0) stale.add(id)
    // route is true only when minRung's row passed.
    else if (e.route !== (e.minRung !== null && e.rungs[e.minRung]?.pass === true)) stale.add(id)
  }
  return [...stale]
}
