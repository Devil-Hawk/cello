// The server's side of the model_jobs queue: four calls to the SQL functions of
// migration 20261120500000. Each takes the admin client explicitly (the functions
// are granted to service_role only) and the person's id, so a caller cannot forget
// whose queue it is touching.

import type { AdminClient } from '@/lib/harness/types'
import { type ClaimedJob, JobRequest, type RelayRung } from './protocol'

export type JobStatus = 'queued' | 'claimed' | 'done' | 'failed'

export interface JobRow {
  id: string
  status: JobStatus
  result: { text?: string } | null
  error: string | null
}

export interface EnqueueInput {
  userId: string
  stepId: string
  rung: RelayRung
  promptHash: string
  request: JobRequest
}

export interface EnqueueResult {
  jobId: string
  status: JobStatus
  result: { text?: string } | null
  /** False when the job (or its finished answer) was already there: nothing new was queued. */
  created: boolean
}

const first = <T>(data: unknown): T | null => (Array.isArray(data) ? ((data[0] as T) ?? null) : ((data as T) ?? null))

/** Queue a job, or find the one already queued, claimed or just finished for this ask. */
export async function enqueueJob(admin: AdminClient, i: EnqueueInput): Promise<EnqueueResult> {
  const { data, error } = await admin.rpc('relay_enqueue', {
    p_user: i.userId,
    p_step: i.stepId,
    p_rung: i.rung,
    p_hash: i.promptHash,
    p_request: i.request,
  })
  if (error) throw new Error(`relay_enqueue failed: ${error.message}`)
  const row = first<{ job_id: string; status: JobStatus; result: { text?: string } | null; created: boolean }>(data)
  if (!row) throw new Error('relay_enqueue returned nothing')
  return { jobId: row.job_id, status: row.status, result: row.result, created: row.created }
}

/** One job for this person at this rung, leased to the caller, or null. */
export async function claimJob(admin: AdminClient, userId: string, rung: RelayRung): Promise<ClaimedJob | null> {
  const { data, error } = await admin.rpc('relay_claim', { p_user: userId, p_rung: rung })
  if (error) throw new Error(`relay_claim failed: ${error.message}`)
  const row = first<{ job_id: string; claim_id: string; step_id: string; rung: RelayRung; request: unknown }>(data)
  if (!row) return null
  const request = JobRequest.safeParse(row.request)
  // A stored request that no longer parses is not handed to a carrier.
  if (!request.success) return null
  return { job_id: row.job_id, claim_id: row.claim_id, step_id: row.step_id, rung: row.rung, request: request.data }
}

export interface CompleteInput {
  userId: string
  jobId: string
  claimId: string
  text?: string
  error?: string
}

/** Finish a claimed job once. False: wrong person, wrong claim, not claimed, or already finished. */
export async function completeJob(admin: AdminClient, i: CompleteInput): Promise<boolean> {
  const { data, error } = await admin.rpc('relay_complete', {
    p_user: i.userId,
    p_job: i.jobId,
    p_claim: i.claimId,
    p_result: i.error === undefined ? { text: i.text ?? '' } : null,
    p_error: i.error ?? null,
  })
  if (error) throw new Error(`relay_complete failed: ${error.message}`)
  return data === true
}

/** The job's current row: the one read made at the end of a wait. */
export async function readJob(admin: AdminClient, userId: string, jobId: string): Promise<JobRow | null> {
  const { data, error } = await admin
    .from('model_jobs')
    .select('id, status, result, error')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`reading a relay job failed: ${error.message}`)
  return (data as JobRow | null) ?? null
}
