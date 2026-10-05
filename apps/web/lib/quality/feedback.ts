// What people do with Cello's output, sent to Langfuse as scores.
//
// Database triggers (migration 20261006000401) queue one feedback_events row
// for each approval, edit, skip, application, reply and interview, carrying the
// trace and observation of the call that wrote the thing. This module sends the
// queue: each event becomes a score named after the behaviour, attached to that
// trace and generation, so an outcome that arrives days later still lands on
// the call that caused it.
//
// Scores (BOOLEAN 1 unless noted):
//   draft_approved, draft_skipped, job_applied, job_dismissed,
//   outreach_replied, interview_scheduled
//   draft_edited   NUMERIC, the word-level edit distance from what the model
//                  wrote to what is in the row now, 0..1
//
// Langfuse keeps traces for 30 days on the free plan, so an event older than 28
// days is marked expired rather than sent into the void, and the queue is
// emptied of anything older than 30 days.

import { createHash } from 'node:crypto'
import type { AdminClient } from '../harness/types'
import { langfuseConfigured, sendScores, type OutcomeScore } from '../observability/langfuse'
import { normalizedEditDistance } from './edit-distance'

export const SIGNALS = [
  'draft_approved',
  'draft_edited',
  'draft_skipped',
  'job_applied',
  'job_dismissed',
  'outreach_replied',
  'interview_scheduled',
] as const
export type Signal = (typeof SIGNALS)[number]

export type SubjectTable = 'outreach_messages' | 'application_drafts' | 'jobs'

const DAY_MS = 24 * 60 * 60 * 1000
/** Langfuse Hobby retention is 30 days; stop sending a little before. */
export const SEND_WINDOW_DAYS = 28
export const KEEP_DAYS = 30
export const MAX_ATTEMPTS = 5

export interface FeedbackEvent {
  userId: string
  signal: Signal
  subjectTable: SubjectTable
  subjectId: string
  traceId: string
  observationId?: string | null
  /** When the traced call ran. Defaults to now. */
  tracedAt?: string
  comment?: string | null
}

interface EventRow {
  id: string
  user_id: string
  signal: Signal
  subject_table: SubjectTable
  subject_id: string
  trace_id: string
  observation_id: string | null
  traced_at: string
  comment: string | null
  attempts: number
}

/** The fields that hold what the model wrote and what is there now. */
const TEXT_COLUMNS: Partial<Record<SubjectTable, { generated: string[]; current: string[] }>> = {
  outreach_messages: { generated: ['generated_subject', 'generated_body'], current: ['subject', 'body'] },
  application_drafts: { generated: ['generated_cover_letter', 'generated_resume_summary'], current: ['cover_letter', 'resume_summary'] },
}

/** Deterministic, so a resend updates the same score instead of adding one. */
export function scoreIdFor(e: { user_id: string; signal: string; subject_table: string; subject_id: string }): string {
  return createHash('sha256').update(`${e.signal}|${e.subject_table}|${e.subject_id}|${e.user_id}`).digest('hex').slice(0, 32)
}

/** For code that already knows an outcome (the engine, scoring): queue it. A
 *  second event for the same person, signal and subject is ignored. */
export async function recordFeedback(admin: AdminClient, e: FeedbackEvent): Promise<void> {
  const { error } = await admin.from('feedback_events').upsert(
    {
      user_id: e.userId,
      signal: e.signal,
      subject_table: e.subjectTable,
      subject_id: e.subjectId,
      trace_id: e.traceId,
      observation_id: e.observationId ?? null,
      traced_at: e.tracedAt ?? new Date().toISOString(),
      comment: e.comment ? e.comment.slice(0, 200) : null,
    },
    { onConflict: 'user_id,signal,subject_table,subject_id', ignoreDuplicates: true }
  )
  if (error) throw new Error(`recordFeedback failed: ${error.message}`)
}

/** Edit distance for one event, or null when there is nothing to measure (the
 *  row is gone, the model's text was never kept, or the text is unchanged). */
async function editDistanceFor(admin: AdminClient, e: EventRow): Promise<number | null> {
  const cols = TEXT_COLUMNS[e.subject_table]
  if (!cols) return null
  const { data, error } = await admin
    .from(e.subject_table)
    .select([...cols.generated, ...cols.current].join(', '))
    .eq('id', e.subject_id)
    .maybeSingle()
  if (error || !data) return null
  const row = data as unknown as Record<string, string | null>
  if (cols.generated.every((c) => row[c] == null)) return null
  const join = (names: string[]) => names.map((c) => row[c] ?? '').join('\n')
  const distance = normalizedEditDistance(join(cols.generated), join(cols.current))
  return distance > 0 ? Math.round(distance * 1000) / 1000 : null
}

export interface ExportResult {
  sent: number
  skipped: number
  failed: number
  deleted: number
}

/**
 * Send pending events as Langfuse scores. Best effort and safe to run often:
 * with Langfuse not configured nothing changes, a failed send adds an attempt
 * to each event (at five the event is marked failed), and a score id is deterministic so a
 * resend never duplicates.
 */
export async function exportFeedback(admin: AdminClient, opts: { limit?: number; now?: Date } = {}): Promise<ExportResult> {
  const now = opts.now ?? new Date()
  const result: ExportResult = { sent: 0, skipped: 0, failed: 0, deleted: 0 }

  const keepCutoff = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString()
  const old = await admin.from('feedback_events').delete({ count: 'exact' }).lt('occurred_at', keepCutoff)
  result.deleted = old.count ?? 0

  if (!langfuseConfigured()) return result

  const { data, error } = await admin
    .from('feedback_events')
    .select('id, user_id, signal, subject_table, subject_id, trace_id, observation_id, traced_at, comment, attempts')
    .eq('status', 'pending')
    .order('occurred_at', { ascending: true })
    .limit(opts.limit ?? 200)
  if (error) throw new Error(`exportFeedback: could not read the queue: ${error.message}`)
  const events = (data ?? []) as EventRow[]

  const expiredBefore = now.getTime() - SEND_WINDOW_DAYS * DAY_MS
  const toSend: { event: EventRow; score: OutcomeScore }[] = []
  const expire: string[] = []

  for (const e of events) {
    if (new Date(e.traced_at).getTime() < expiredBefore) {
      expire.push(e.id)
      continue
    }
    let value = 1
    let dataType: OutcomeScore['dataType'] = 'BOOLEAN'
    if (e.signal === 'draft_edited') {
      const distance = await editDistanceFor(admin, e)
      if (distance === null) {
        expire.push(e.id)
        continue
      }
      value = distance
      dataType = 'NUMERIC'
    }
    toSend.push({
      event: e,
      score: {
        id: scoreIdFor(e),
        traceId: e.trace_id,
        ...(e.observation_id ? { observationId: e.observation_id } : {}),
        name: e.signal,
        value,
        dataType,
        ...(e.comment ? { comment: e.comment } : {}),
      },
    })
  }

  if (expire.length > 0) {
    await admin.from('feedback_events').update({ status: 'expired' }).in('id', expire)
    result.skipped = expire.length
  }

  if (toSend.length === 0) return result

  const ok = await sendScores(toSend.map((x) => x.score))
  if (ok) {
    await admin
      .from('feedback_events')
      .update({ status: 'sent', sent_at: now.toISOString() })
      .in('id', toSend.map((x) => x.event.id))
    result.sent = toSend.length
    return result
  }

  // The send failed: count the attempt on each event, and give up on one after MAX_ATTEMPTS.
  for (const { event } of toSend) {
    const attempts = event.attempts + 1
    await admin
      .from('feedback_events')
      .update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' } : {}) })
      .eq('id', event.id)
  }
  result.failed = toSend.length
  return result
}
