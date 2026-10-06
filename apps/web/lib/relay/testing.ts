// An in-memory stand-in for the three relay SQL functions, with the same rules the SQL
// enforces (owner, claim id, status). It exists so the TypeScript above the queue is
// tested without a database; the SQL itself is proved by
// supabase/checks/extension-models_relay.sql.

import type { AdminClient } from '@/lib/harness/types'

export interface FakeJob {
  id: string
  user_id: string
  step_id: string
  rung: 'R1' | 'R2'
  prompt_hash: string
  request: unknown
  status: 'queued' | 'claimed' | 'done' | 'failed'
  claim_id: string | null
  result: { text?: string; model?: string } | null
  error: string | null
  prov: Record<string, unknown> | null
}

export function fakeRelay() {
  const jobs: FakeJob[] = []
  let n = 0
  const id = (kind: string): string => `${String(++n).padStart(8, '0')}-0000-4000-8000-${kind.padStart(12, '0')}`

  const rpc = async (name: string, a: Record<string, unknown>) => {
    if (name === 'relay_enqueue') {
      const open = jobs.find(
        (j) => j.user_id === a.p_user && j.step_id === a.p_step && j.prompt_hash === a.p_hash && (j.status === 'queued' || j.status === 'claimed'),
      )
      const done = jobs.find((j) => j.user_id === a.p_user && j.step_id === a.p_step && j.prompt_hash === a.p_hash && j.status === 'done')
      const hit = open ?? done
      if (hit) return { data: [{ job_id: hit.id, status: hit.status, result: hit.result, created: false }], error: null }
      const job: FakeJob = {
        id: id('1'),
        user_id: a.p_user as string,
        step_id: a.p_step as string,
        rung: a.p_rung as 'R1' | 'R2',
        prompt_hash: a.p_hash as string,
        request: a.p_request,
        status: 'queued',
        claim_id: null,
        result: null,
        error: null,
        prov: null,
      }
      jobs.push(job)
      return { data: [{ job_id: job.id, status: 'queued', result: null, created: true }], error: null }
    }
    if (name === 'relay_claim') {
      const job = jobs.find((j) => j.user_id === a.p_user && j.rung === a.p_rung && j.status === 'queued')
      if (!job) return { data: [], error: null }
      job.status = 'claimed'
      job.claim_id = id('2')
      return { data: [{ job_id: job.id, claim_id: job.claim_id, step_id: job.step_id, rung: job.rung, request: job.request }], error: null }
    }
    if (name === 'relay_complete') {
      const job = jobs.find((j) => j.id === a.p_job && j.user_id === a.p_user && j.claim_id === a.p_claim && j.status === 'claimed')
      if (!a.p_model) return { data: null, error: { message: 'a result must name the model that answered' } }
      if (!job) return { data: false, error: null }
      job.prov = { step: job.step_id, model: a.p_model, rung: job.rung, evidence: [] }
      job.status = a.p_error === null ? 'done' : 'failed'
      job.result = a.p_error === null ? { ...(a.p_result as { text?: string }), model: a.p_model as string } : null
      job.error = (a.p_error as string | null) ?? null
      return { data: true, error: null }
    }
    return { data: null, error: { message: `unknown rpc ${name}` } }
  }

  const from = (table: string) => {
    if (table !== 'model_jobs') throw new Error(`unexpected table ${table}`)
    const filters: Record<string, unknown> = {}
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        filters[col] = v
        return q
      },
      maybeSingle: async () => ({
        data: jobs.find((j) => Object.entries(filters).every(([k, v]) => (j as unknown as Record<string, unknown>)[k] === v)) ?? null,
        error: null,
      }),
    }
    return q
  }

  const admin = { rpc, from } as unknown as AdminClient
  return { admin, jobs }
}
