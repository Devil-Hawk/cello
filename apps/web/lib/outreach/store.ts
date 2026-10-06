// CRUD for public.outreach_messages via a Supabase client.
//
// The table is not in @cello/shared's generated Database type, so this uses an
// untyped client (server client for RLS-scoped reads, or the service-role admin
// client for writes) with the row shape declared in ./types.
//
// THE TEXT LIVES ON AN ARTIFACT VERSION (K17). A message is an `artifacts` row of type
// `message`; insertOutreach writes that first and links the row to it (artifact_id,
// artifact_version), and a change to the subject or body adds a version before the row
// changes. The row keeps who, approval, sending and reply, and still mirrors the text in
// its own columns: the send route and the readers that list messages use them.
// ponytail: dual write. Drop the columns when those readers read the version.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { addVersion, createArtifact } from '../agents/artifacts'
import type { AdminClient } from '../harness/types'
import type { OutreachMessageRow, OutreachStatus, ReplyClassification, TemplateReason } from './types'
import { recordInteraction } from '../interactions/store'
import { traceRefFor } from '../trace/spans'

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
  /** False when the text is the deterministic template, not a model draft. */
  used_llm?: boolean
  /** Why the text is the template. Set only when used_llm is false. */
  template_reason?: TemplateReason | null
  /** The artifact version that already holds this text (a draft queued from an artifact). Absent: one is made. */
  artifact_id?: string | null
  artifact_version?: number | null
}

const asAdmin = (client: SupabaseClient) => client as unknown as AdminClient

function messageContent(m: { subject: string; body: string; to_name?: string | null; to_email?: string | null; kind?: string | null }, outreachId: string) {
  return { subject: m.subject, body: m.body, to_name: m.to_name ?? null, to_email: m.to_email ?? null, outreach_id: outreachId, kind: m.kind === 'follow_up' ? 'follow_up' : 'initial' }
}

/**
 * True when no message to this address has gone out yet: the person is writing to someone
 * new. The approval shows it beside the address, because a first message to a stranger is
 * the one worth a second look.
 */
export async function isNewRecipient(client: SupabaseClient, userId: string, toEmail: string): Promise<boolean> {
  const { data } = await client.from(TABLE).select('id').eq('user_id', userId).eq('status', 'sent').ilike('to_email', toEmail.trim().replace(/[\\%_]/g, (c) => `\\${c}`)).limit(1)
  return ((data as unknown[] | null) ?? []).length === 0
}

export async function insertOutreach(
  client: SupabaseClient,
  row: NewOutreach
): Promise<OutreachMessageRow> {
  // The artifact first: the text is made once, on its version, and the row points at it.
  const id = randomUUID()
  let madeArtifact: string | null = null
  if (!row.artifact_id) {
    const ref = await createArtifact(asAdmin(client), {
      userId: row.user_id,
      type: 'message',
      title: `${row.kind === 'follow_up' ? 'Follow-up' : 'Email'} to ${row.to_name ?? row.to_email}`,
      content: messageContent(row, id),
      author: 'cello',
      jobId: row.job_id ?? null,
      companyId: row.company_id ?? null,
      contactId: row.contact_id ?? null,
      idempotencyKey: `outreach:${id}`,
    })
    madeArtifact = ref.id
    row = { ...row, artifact_id: ref.id, artifact_version: ref.version }
  }
  // A model draft remembers the call that wrote it and what it first said, so
  // an approval, an edit or a reply later can be scored on that call. A
  // template, or a trace that was not exported, stamps nothing.
  const fromModel = row.used_llm !== false
  const ref = fromModel ? traceRefFor(row.kind === 'follow_up' ? 'draft-follow-up' : 'draft-outreach-message') : null
  const stamped = ref ? { ...row, ...ref, generated_subject: row.subject, generated_body: row.body } : row
  const { data, error } = await client.from(TABLE).insert({ id, ...stamped }).select('*').single()
  if (error) {
    // The row did not land: the artifact made for it would be an orphan.
    if (madeArtifact) {
      try {
        await client.from('artifacts').delete().eq('id', madeArtifact).eq('user_id', row.user_id)
      } catch {
        // An orphan artifact is harmless, and the original error is the one worth raising.
      }
    }
    // The Postgres code rides along so a caller can tell the unique-index race
    // (23505) from a real fault without parsing the message.
    throw Object.assign(new Error(`insertOutreach failed: ${error.message}`), { code: error.code })
  }
  return data as OutreachMessageRow
}

export async function getOutreach(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<OutreachMessageRow | null> {
  const { data } = await client.from(TABLE).select('*').eq('id', id).eq('user_id', userId).single()
  const row = (data as OutreachMessageRow | null) ?? null
  if (!row?.artifact_id || !row.artifact_version) return row // a row from before the copy: its own columns are the text
  // The text is read from its artifact version; the row's columns are the fallback.
  const { data: version } = await client
    .from('artifact_versions')
    .select('content')
    .eq('artifact_id', row.artifact_id)
    .eq('version', row.artifact_version)
    .maybeSingle()
  const c = (version as { content?: { subject?: string; body?: string } } | null)?.content
  return c && typeof c.subject === 'string' && typeof c.body === 'string' ? { ...row, subject: c.subject, body: c.body } : row
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
  // A change to the text is a new version of the message first, then the row follows it.
  let versioned: Partial<OutreachMessageRow> = {}
  if (fields.subject !== undefined || fields.body !== undefined) {
    const { data: cur } = await client.from(TABLE).select('artifact_id, subject, body, to_name, to_email, kind, job_id, company_id, contact_id').eq('id', id).eq('user_id', userId).maybeSingle()
    const current = cur as Pick<OutreachMessageRow, 'artifact_id' | 'subject' | 'body' | 'to_name' | 'to_email' | 'kind' | 'job_id' | 'company_id' | 'contact_id'> | null
    if (current) {
      const next = { ...current, subject: fields.subject ?? current.subject, body: fields.body ?? current.body }
      const content = messageContent(next, id)
      if (current.artifact_id) {
        const version = await addVersion(asAdmin(client), { userId, artifactId: current.artifact_id, author: 'user', content, note: 'Edited' })
        versioned = { artifact_version: version }
      } else {
        // A row made before the copy and never linked: make its artifact now.
        const ref = await createArtifact(asAdmin(client), {
          userId,
          type: 'message',
          title: `${next.kind === 'follow_up' ? 'Follow-up' : 'Email'} to ${next.to_name ?? next.to_email}`,
          content,
          author: 'user',
          jobId: next.job_id,
          companyId: next.company_id,
          contactId: next.contact_id,
          idempotencyKey: `outreach:${id}`,
        })
        versioned = { artifact_id: ref.id, artifact_version: ref.version }
      }
    }
  }
  const { data, error } = await client
    .from(TABLE)
    .update({ ...fields, ...versioned, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(`updateOutreach failed: ${error.message}`)
  const row = data as OutreachMessageRow

  // STEP 5 projection: every status transition to 'sent' routes through
  // here (the send route, the only caller that sets it) — the single write
  // path an interaction timeline entry belongs on, not a scattered call at
  // the route level.
  if (fields.status === 'sent') {
    await recordInteraction(client, {
      userId,
      companyId: row.company_id,
      contactId: row.contact_id,
      jobId: row.job_id,
      kind: 'outreach_sent',
      occurredAt: row.sent_at ?? row.updated_at,
      title: `Outreach sent — ${row.subject}`,
      refTable: TABLE,
      refId: row.id,
      metadata: { kind: row.kind, to_email: row.to_email },
    })
  }

  return row
}

export interface OutreachReplyMatch {
  userId: string
  gmailThreadId: string
  gmailMessageId: string
  classification: ReplyClassification
  occurredAt: string
}

/**
 * STEP 5 Gmail reply bridge (ruling 4's "single writer" — lib/gmail's
 * inbound sync loop is the only caller). `.is('replied_at', null)` in the
 * WHERE clause IS the idempotency guarantee: a second sync pass over the
 * same thread finds zero rows still NULL and updates nothing — first reply
 * wins, no separate fetch-then-check race to get wrong.
 *
 * ponytail: a thread can carry more than one outreach row (an initial plus
 * its chained follow-up share one Gmail thread — see app/api/outreach/send's
 * `threadId: parentThread`); one inbound reply answers the whole thread, so
 * every still-unreplied row on it is stamped, not just the first found.
 *
 * Never touches `activities` — see supabase/migrations/
 * 20260729000001_application_receipts.sql's header for why an outreach
 * reply and a job-application-status email are categorically different
 * events and must not share a table.
 */
export async function recordOutreachReply(
  client: SupabaseClient,
  match: OutreachReplyMatch
): Promise<OutreachMessageRow[]> {
  const { data, error } = await client
    .from(TABLE)
    .update({
      replied_at: match.occurredAt,
      reply_gmail_message_id: match.gmailMessageId,
      reply_classification: match.classification,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', match.userId)
    .eq('gmail_thread_id', match.gmailThreadId)
    .is('replied_at', null)
    .select('*')
  if (error) throw new Error(`recordOutreachReply failed: ${error.message}`)
  const rows = (data as OutreachMessageRow[]) ?? []

  for (const row of rows) {
    await recordInteraction(client, {
      userId: match.userId,
      companyId: row.company_id,
      contactId: row.contact_id,
      jobId: row.job_id,
      kind: 'reply_received',
      occurredAt: match.occurredAt,
      title: `Reply received — ${row.subject}`,
      refTable: TABLE,
      refId: row.id,
      metadata: { classification: match.classification, gmail_message_id: match.gmailMessageId },
    })
  }

  return rows
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

/** The statuses that still hold the (user, contact, job) slot. MUST match the
 *  partial unique index uniq_outreach_initial_contact_job (migration
 *  20261005100001): a dismissed ('skipped') draft frees the slot, a failed one
 *  does not because it can be retried. */
export const ACTIVE_INITIAL_STATUSES = ['pending_review', 'approved', 'sent', 'failed'] as const

/** True when an insertOutreach error is the unique-index refusal. */
export function isDuplicateOutreachError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/**
 * Existing INITIAL outreach still holding the slot for (user, contact, job):
 * the hard dedupe check ("one email per contact per role, no repeat pestering").
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
    .in('status', [...ACTIVE_INITIAL_STATUSES])
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
