// Rung evals: for each model step, how well each rung does its job, measured, and
// written to lib/steps/rungs.json. Default routing uses a rung below R3 only for a
// step whose row passed on the step's current prompt. A step with no eval set is
// written as "not measured" and never routes; it is never written as passing.
//
//   npx tsx lib/relay/rungs.ts --step inbox.classify --rung R1,R3     (owner-run)
//
// R3 runs on the operator's eval key (OPENROUTER_API_KEY, at most 300 requests a run).
// R1 and R2 run as relay jobs on the owner's account (OWNER_USER_ID): the owner's open
// Cello tab or extension answers them, so a rung run also proves the relay end to end.
// This is also how spikes SP1 (inbox.classify on R1 against R3) and SP2 (one reply
// draft on R2) are run.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AdminClient } from '@/lib/harness/types'
import type { LocalRequest } from './local'
import { type EnqueueResult, enqueueJob } from './queue'
import { promptHash } from './protocol'
import { realtimeWaiter } from './wait'

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

// ---------------------------------------------------------------------------------
// The runner (owner-run, never in CI).
// ---------------------------------------------------------------------------------

interface RunDeps {
  admin: AdminClient
  userId: string
  fetchImpl?: typeof fetch
  /** Seconds to wait for a carrier per case. */
  waitMs?: number
}

const MAX_R3_REQUESTS = 300
let r3Used = 0

async function runR3(c: EvalCase, d: RunDeps): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY (the eval key) is not set')
  if (++r3Used > MAX_R3_REQUESTS) throw new Error('300 requests reached for this run')
  const model = process.env.RUNG_EVAL_R3_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free'
  const res = await (d.fetchImpl ?? fetch)('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: c.messages }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return json.choices?.[0]?.message?.content ?? null
}

async function runRelay(id: string, rung: 'R1' | 'R2', c: EvalCase, d: RunDeps): Promise<string | null> {
  const request = { messages: c.messages }
  const queued: EnqueueResult = await enqueueJob(d.admin, { userId: d.userId, stepId: id, rung, promptHash: promptHash(id, rung, request), request })
  if (queued.status === 'done') return queued.result?.text ?? null
  const row = await realtimeWaiter(d.admin, d.userId)(queued.jobId, d.waitMs ?? 120_000)
  if (!row) throw new Error(`No carrier answered a ${rung} job. Open Cello (R1 or R2) or the extension (R2) and run again.`)
  return row.status === 'done' ? (row.result?.text ?? null) : null
}

/** Measure one step on the given rungs and return its new entry (rungs not asked for are kept). */
export async function measureStep(id: string, set: StepSet, rungs: EvalRung[], d: RunDeps, kept: StepEntry['rungs'] = {}): Promise<StepEntry> {
  const cases = set.cases()
  const out: StepEntry['rungs'] = { ...kept }
  for (const rung of rungs) {
    const replies: Array<string | null> = []
    for (const c of cases) replies.push(rung === 'R3' ? await runR3(c, d) : await runRelay(id, rung, c, d))
    const score = set.score(replies, cases)
    out[rung] = {
      model: rung === 'R3' ? (process.env.RUNG_EVAL_R3_MODEL ?? 'meta-llama/llama-3.3-70b-instruct:free') : rung === 'R2' ? 'relay: this computer' : 'relay: this browser',
      cases: cases.length,
      score,
      bar: set.bar,
      pass: score >= set.bar,
    }
  }
  return entryFrom(out, stepHash(id, set))
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const ids = arg('step')?.split(',') ?? Object.keys(STEP_SETS)
  const rungs = (arg('rung') ?? 'R3').split(',') as EvalRung[]
  const userId = process.env.OWNER_USER_ID
  if (!userId) throw new Error('OWNER_USER_ID is not set: R1 and R2 jobs run on the owner account')
  const { createAdminClient } = await import('@/lib/harness/supabase-admin')
  const d: RunDeps = { admin: createAdminClient(), userId }
  const file = path.resolve(process.cwd(), 'lib/steps/rungs.json')
  const current = readRungs(file)
  for (const id of ids) {
    const set = STEP_SETS[id]
    if (!set) {
      console.log(`${id}: no eval set yet, left as not measured`)
      continue
    }
    // A changed prompt drops old rows: they measured something else.
    const same = current.steps[id]?.promptHash === stepHash(id, set)
    current.steps[id] = await measureStep(id, set, rungs, d, same ? current.steps[id]?.rungs : {})
    console.log(`${id}: ${JSON.stringify(current.steps[id]?.rungs)}`)
  }
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n')
}

if (process.argv[1]?.endsWith(path.join('relay', 'rungs.ts'))) void main()
