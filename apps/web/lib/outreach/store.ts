// CRUD for public.outreach_messages via a Supabase client.
//
// The table is not in @cello/shared's generated Database type, so this uses an
// untyped client (server client for RLS-scoped reads, or the service-role admin
// client for writes) with the row shape declared in ./types.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OutreachMessageRow, OutreachStatus } from './types'

const TABLE = 'outreach_messages'

export interface NewOutreach {
  user_id: string
  contact_id?: string | null
  job_id?: string | null
  company_id?: string | null
  run_id?: string | null
  to_email: string
  to_name?: string | null
  subject: string
  body: string
  status?: OutreachStatus
  kind?: 'initial' | 'follow_up'
  parent_id?: string | null
}

export async function insertOutreach(
  client: SupabaseClient,
  row: NewOutreach
): Promise<OutreachMessageRow> {
  const { data, error } = await client.from(TABLE).insert(row).select('*').single()
  if (error) throw new Error(`insertOutreach failed: ${error.message}`)
  return data as OutreachMessageRow
}

export async function getOutreach(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<OutreachMessageRow | null> {
  const { data } = await client.from(TABLE).select('*').eq('id', id).eq('user_id', userId).single()
  return (data as OutreachMessageRow | null) ?? null
}

export async function listOutreach(
  client: SupabaseClient,
  userId: string,
  opts: { status?: OutreachStatus; limit?: number } = {}
): Promise<OutreachMessageRow[]> {
  let q = client.from(TABLE).select('*').eq('user_id', userId)
  if (opts.status) q = q.eq('status', opts.status)
  q = q.order('created_at', { ascending: false }).limit(Math.min(200, Math.max(1, opts.limit ?? 100)))
  const { data, error } = await q
  if (error) throw new Error(`listOutreach failed: ${error.message}`)
  return (data as OutreachMessageRow[]) ?? []
}

export async function updateOutreach(
  client: SupabaseClient,
  userId: string,
  id: string,
  fields: Partial<OutreachMessageRow>
): Promise<OutreachMessageRow> {
  const { data, error } = await client
    .from(TABLE)
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(`updateOutreach failed: ${error.message}`)
  return data as OutreachMessageRow
}

export async function deleteOutreach(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  const { error } = await client.from(TABLE).delete().eq('id', id).eq('user_id', userId)
  if (error) throw new Error(`deleteOutreach failed: ${error.message}`)
}

/** UTC start-of-day ISO used for the daily-cap window. */
export function startOfUtcDay(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return d.toISOString()
}

/** Count messages actually SENT today (UTC) — the daily-cap counter. */
export async function countSentToday(client: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await client
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'sent')
    .gte('sent_at', startOfUtcDay())
  if (error) throw new Error(`countSentToday failed: ${error.message}`)
  return count ?? 0
}

/**
 * Existing non-skipped INITIAL outreach for (user, contact, job) — the hard
 * dedupe check ("one email per contact per role, no repeat pestering").
 */
export async function findDuplicateInitial(
  client: SupabaseClient,
  userId: string,
  contactId: string,
  jobId: string | null
): Promise<OutreachMessageRow | null> {
  let q = client
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .eq('kind', 'initial')
    .in('status', ['pending_review', 'approved', 'sent'])
  q = jobId ? q.eq('job_id', jobId) : q.is('job_id', null)
  const { data } = await q.limit(1)
  const rows = (data as OutreachMessageRow[]) ?? []
  return rows[0] ?? null
}

/** Existing follow-up for a parent message (follow-up cap = ONE). */
export async function findFollowUp(
  client: SupabaseClient,
  userId: string,
  parentId: string
): Promise<OutreachMessageRow | null> {
  const { data } = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('kind', 'follow_up')
    .eq('parent_id', parentId)
    .limit(1)
  const rows = (data as OutreachMessageRow[]) ?? []
  return rows[0] ?? null
}
