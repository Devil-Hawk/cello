// Rung evals, owner-run. R3 runs on the operator's eval key (OPENROUTER_API_KEY, at most
// 300 requests a run). R1 and R2 run as relay jobs on the owner's account
// (OWNER_USER_ID): the owner's open Cello tab (R1, R2) or extension (R2) answers them, so
// a rung run also proves the relay end to end. This is how spikes SP1 (inbox.classify on
// R1 against R3) and SP2 (one reply draft on R2) are run.
//
//   pnpm rungs:eval --step inbox.classify --rung R1,R3
//
// It writes lib/steps/rungs.json. Never run by CI or by a request.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AdminClient } from '../lib/harness/types'
import { promptHash } from '../lib/relay/protocol'
import { enqueueJob } from '../lib/relay/queue'
import { entryFrom, type EvalCase, type EvalRung, readRungs, STEP_SETS, stepHash, type StepEntry, type StepSet } from '../lib/relay/rungs'
import { realtimeWaiter } from '../lib/relay/wait'


export interface RunDeps {
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
  const queued = await enqueueJob(d.admin, { userId: d.userId, stepId: id, rung, promptHash: promptHash(id, rung, request), request })
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
  const { createAdminClient } = await import('../lib/harness/supabase-admin')
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

if (process.argv[1]?.endsWith('rungs-eval.ts')) void main()
