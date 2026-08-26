// interactions — the unified per-company/contact timeline (STEP 5, see
// supabase/migrations/20260816000004_interactions.sql for the schema this
// operates on). recordInteraction is the ONLY writer: every source store
// function (outreach send, Gmail stage transition, follow-up completion,
// application submission) calls it after its OWN write succeeds. Idempotent
// upsert on (ref_table, ref_id, kind) — calling it twice for the same
// source event (a retried request, a replayed graph task) updates the row
// instead of duplicating the timeline entry.
//
// company_id is resolved ONCE here, at projection time, through
// lib/entities/companies.ts#resolveCompanyId — the timeline is an aggregate
// CONSUMER of company identity (a merge is pure indirection; a caller may
// hand this the pre-merge id it already had on hand), never a second place
// that decides it. contact_id has no equivalent merge/indirection concept
// in this codebase, so it is stored exactly as given.
//
// reply_received is written by lib/outreach/store.ts#recordOutreachReply —
// the STEP 5 Gmail reply bridge (ruling 4's single writer for the
// outreach_messages reply columns), called from the Gmail sync loop when an
// inbound message's thread matches a tracked outreach thread.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyId } from '../entities/companies'

export type InteractionKind =
  | 'outreach_sent'
  | 'reply_received'
  | 'interview'
  | 'stage_change'
  | 'follow_up_done'
  | 'note'
  | 'application_submitted'
  | 'autopilot_action'

export interface NewInteraction {
  userId: string
  companyId?: string | null
  contactId?: string | null
  jobId?: string | null
  applicationId?: string | null
  kind: InteractionKind
  occurredAt: string
  title?: string | null
  body?: string | null
  refTable: string
  refId: string
  metadata?: Record<string, unknown> | null
}

export interface InteractionRow {
  id: string
  user_id: string
  company_id: string | null
  contact_id: string | null
  job_id: string | null
  application_id: string | null
  kind: InteractionKind
  occurred_at: string
  title: string | null
  body: string | null
  ref_table: string
  ref_id: string
  metadata: Record<string, unknown> | null
  created_at: string
}

const TABLE = 'interactions'

/**
 * Idempotent upsert on (ref_table, ref_id, kind). Never throws: a
 * projection failure must not roll back or fail the source write it
 * follows (the send, the stage transition, the receipt) — it is
 * observability riding along on a write that already succeeded, matching
 * lib/graph/journal.ts's log-and-continue idiom for the same reason.
 */
export async function recordInteraction(
  client: SupabaseClient,
  row: NewInteraction
): Promise<InteractionRow | null> {
  const companyId = row.companyId ? await resolveCompanyId(client, row.companyId) : null
  const payload = {
    user_id: row.userId,
    company_id: companyId,
    contact_id: row.contactId ?? null,
    job_id: row.jobId ?? null,
    application_id: row.applicationId ?? null,
    kind: row.kind,
    occurred_at: row.occurredAt,
    title: row.title ?? null,
    body: row.body ?? null,
    ref_table: row.refTable,
    ref_id: row.refId,
    metadata: row.metadata ?? null,
  }
  const { data, error } = await client
    .from(TABLE)
    .upsert(payload, { onConflict: 'ref_table,ref_id,kind' })
    .select('*')
    .single()
  if (error) {
    console.error(
      `[interactions] recordInteraction failed for ${row.refTable}/${row.refId}/${row.kind}: ${error.message}`
    )
    return null
  }
  return data as InteractionRow
}

export interface TimelineFilter {
  companyId?: string
  contactId?: string
  applicationId?: string
}

/** One company's, contact's, or application's unified history, newest first. */
export async function timelineFor(
  client: SupabaseClient,
  userId: string,
  filter: TimelineFilter,
  limit = 100
): Promise<InteractionRow[]> {
  let q = client.from(TABLE).select('*').eq('user_id', userId)
  if (filter.companyId) q = q.eq('company_id', filter.companyId)
  if (filter.contactId) q = q.eq('contact_id', filter.contactId)
  if (filter.applicationId) q = q.eq('application_id', filter.applicationId)
  q = q.order('occurred_at', { ascending: false }).limit(Math.min(200, Math.max(1, limit)))
  const { data, error } = await q
  if (error) throw new Error(`timelineFor failed: ${error.message}`)
  return (data as InteractionRow[]) ?? []
}
