// Approvals: the only way an email leaves or an application goes out.
//
// No agent can send or submit. When Cello wants to, request_approval calls
// queueApproval, which writes one row: the exact artifact version, a hash of the
// payload, and the outreach message or application draft in pending review that the
// existing send and submit code already knows how to handle. "Needs you" lists the
// pending rows. The person's click calls decideApproval, which runs plain code:
// one conditional update claims the row, the send or submit path runs, and its
// outcome is stored. Approving twice runs it once.
//
// This is the only file under lib/agents allowed to import the send and submit
// code; chokepoints.test.ts scans for it. A task set to "act within my rules" goes
// through the same decideApproval, by 'rule', and only for what its stored rules
// allow. It never submits an application unless the rule says so.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { approveDraft, sendOutreach } from './send.stub'
import { findDuplicateInitial, findFollowUp, insertOutreach, isDuplicateOutreachError, updateOutreach } from '@/lib/outreach/store'
import type { AdminClient } from '@/lib/harness/types'
import { scoreTrace } from '@/lib/observability/langfuse'
import { addVersion, getArtifact, type ArtifactContent } from './artifacts'
import type { AgentContext, Autonomy, AutonomyRules } from './context'
import { DEMO_SEND_REFUSAL } from './middleware'
import { ownedJobsQuery } from '@/lib/jobs/owned-query'

export type ApprovalAction = 'send_email' | 'submit_application'
export type ApprovalStatus = 'pending' | 'executing' | 'done' | 'failed' | 'skipped'

export interface ApprovalRow {
  id: string
  user_id: string
  conversation_id: string | null
  thread_id: string | null
  scheduled_task_id: string | null
  action: ApprovalAction
  artifact_id: string
  artifact_version: number
  payload_hash: string
  target_table: 'outreach_messages' | 'application_drafts'
  target_id: string
  status: ApprovalStatus
  decided_by: 'user' | 'rule' | null
  decided_at: string | null
  executed_at: string | null
  outcome: Outcome | null
  error: string | null
  posted_at: string | null
  idempotency_key: string
  trace_id: string | null
  created_at: string
}

export interface Outcome {
  /** What happened, in plain words. */
  what: string
  when: string
  artifact_version: number
  approval_id: string
  result: Record<string, unknown>
}

const COLUMNS =
  'id, user_id, conversation_id, thread_id, scheduled_task_id, action, artifact_id, artifact_version, payload_hash, target_table, target_id, status, decided_by, decided_at, executed_at, outcome, error, posted_at, idempotency_key, trace_id, created_at'

export const WAITING_COPY = 'Waiting for your approval in Needs you.'
export const SKIPPED_COPY = 'Skipped. Nothing was sent.'
export const STALE_COPY = 'The draft changed after it was queued. Review the new version and approve again.'
export const GMAIL_REAUTH_COPY = 'Not sent: Gmail needs you to sign in again. Reconnect in Settings.'

export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** What exactly the person approves: the words, the recipient or role, and the version. */
export function payloadFor(action: ApprovalAction, version: number, content: Record<string, unknown>, target: Record<string, unknown>) {
  return { action, version, ...content, ...target }
}

export type Fix = { ok: false; error: string; fix: string }

// --- queue --------------------------------------------------------------------------

export interface QueueInput {
  action: ApprovalAction
  artifactId: string
  contactId?: string
  jobId?: string
  idempotencyKey: string
}

export type QueueResult = { ok: true; approval: ApprovalRow; created: boolean } | Fix

async function findByKey(admin: AdminClient, userId: string, key: string): Promise<ApprovalRow | null> {
  const { data } = await admin.from('approvals').select(COLUMNS).eq('user_id', userId).eq('idempotency_key', key).maybeSingle()
  return (data as ApprovalRow | null) ?? null
}

/** Queue an email or an application for the person to approve. Never sends. Idempotent by key. */
export async function queueApproval(ctx: AgentContext, input: QueueInput): Promise<QueueResult> {
  const { admin, userId } = ctx
  const existing = await findByKey(admin, userId, input.idempotencyKey)
  if (existing) return { ok: true, approval: existing, created: false }

  if (ctx.isDemo && input.action === 'send_email') return { ok: false, error: DEMO_SEND_REFUSAL, fix: 'Tell the person demo accounts can draft but not send.' }

  const got = await getArtifact(admin, userId, input.artifactId)
  if (!got) return { ok: false, error: `No artifact with id ${input.artifactId}.`, fix: 'Use an artifact_id returned by create_artifact.' }
  const { artifact, version } = got

  let target: { table: ApprovalRow['target_table']; id: string; payload: Record<string, unknown> }
  if (input.action === 'send_email') {
    const queued = await materializeEmail(admin, ctx, artifact, version.content as ArtifactContent<'outreach_email'>, version.version, input)
    if (!queued.ok) return queued
    target = queued.target
  } else {
    const queued = await materializeApplication(admin, userId, artifact, version.content_text, version.version, input)
    if (!queued.ok) return queued
    target = queued.target
  }

  const { data, error } = await admin
    .from('approvals')
    .insert({
      user_id: userId,
      conversation_id: ctx.conversationId,
      thread_id: ctx.threadId || null,
      scheduled_task_id: ctx.scheduledTaskId ?? null,
      action: input.action,
      artifact_id: artifact.id,
      artifact_version: version.version,
      payload_hash: hash(payloadFor(input.action, version.version, {}, target.payload)),
      target_table: target.table,
      target_id: target.id,
      idempotency_key: input.idempotencyKey,
      trace_id: ctx.traceId,
    })
    .select(COLUMNS)
    .single()
  if (error || !data) {
    if ((error as { code?: string } | null)?.code === '23505') {
      const raced = await findByKey(admin, userId, input.idempotencyKey)
      if (raced) return { ok: true, approval: raced, created: false }
    }
    return { ok: false, error: `Could not queue the approval: ${error?.message ?? 'no row'}`, fix: 'Try again.' }
  }
  return { ok: true, approval: data as ApprovalRow, created: true }
}

type Materialized = { ok: true; target: { table: ApprovalRow['target_table']; id: string; payload: Record<string, unknown> } } | Fix

async function materializeEmail(
  admin: AdminClient,
  ctx: AgentContext,
  artifact: { id: string; type: string; contact_id: string | null; job_id: string | null; company_id: string | null },
  content: ArtifactContent<'outreach_email'>,
  versionNumber: number,
  input: QueueInput
): Promise<Materialized> {
  if (artifact.type !== 'outreach_email') {
    return { ok: false, error: `A ${artifact.type.replace('_', ' ')} cannot be sent as an email.`, fix: 'Use an outreach_email artifact.' }
  }
  const contactId = input.contactId ?? artifact.contact_id
  if (!contactId) return { ok: false, error: 'There is no contact to send this to.', fix: 'Pass contact_id, or use an email that was written for a contact.' }
  const { data: contact } = await admin.from('contacts').select('id, name, email, company_id').eq('id', contactId).eq('user_id', ctx.userId).maybeSingle()
  const c = contact as { id: string; name: string | null; email: string | null; company_id: string | null } | null
  if (!c) return { ok: false, error: `No contact with id ${contactId}.`, fix: 'Call people() and use a contact_id it returned.' }
  if (!c.email) return { ok: false, error: `${c.name ?? 'This contact'} has no email address.`, fix: 'Ask the person for an address, or choose a contact that has one.' }
  const jobId = input.jobId ?? artifact.job_id
  const kind = content.kind ?? 'initial'

  let parentId: string | null = null
  if (kind === 'follow_up') {
    const { data } = await admin
      .from('outreach_messages')
      .select('id')
      .eq('user_id', ctx.userId)
      .eq('contact_id', c.id)
      .eq('kind', 'initial')
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(1)
    parentId = ((data as { id: string }[] | null) ?? [])[0]?.id ?? null
    if (!parentId) return { ok: false, error: `No email to ${c.name ?? 'this contact'} has been sent yet, so there is nothing to follow up on.`, fix: 'Send the first email before a follow-up.' }
    if (await findFollowUp(admin, ctx.userId, parentId)) return { ok: false, error: 'A follow-up to this email already exists.', fix: 'One follow-up per email. Do not queue another.' }
  } else {
    const duplicate = await findDuplicateInitial(admin, ctx.userId, c.id, jobId)
    if (duplicate) {
      return { ok: false, error: `An email to ${c.name ?? 'this contact'} about this role is already ${duplicate.status === 'pending_review' ? 'waiting for approval' : duplicate.status}.`, fix: 'Do not queue it again. Tell the person where it is.' }
    }
  }

  try {
    const row = await insertOutreach(admin as unknown as SupabaseClient, {
      user_id: ctx.userId,
      contact_id: c.id,
      job_id: jobId,
      company_id: artifact.company_id ?? c.company_id,
      to_email: c.email,
      to_name: c.name,
      subject: content.subject,
      body: content.body,
      status: 'pending_review',
      kind,
      parent_id: parentId,
      used_llm: true,
    })
    return { ok: true, target: { table: 'outreach_messages', id: row.id, payload: { subject: content.subject, body: content.body, to_email: c.email, kind } } }
  } catch (e) {
    if (isDuplicateOutreachError(e)) return { ok: false, error: 'An email to this contact about this role is already queued.', fix: 'Do not queue it again.' }
    return { ok: false, error: `Could not prepare the email: ${e instanceof Error ? e.message : String(e)}`, fix: 'Try again.' }
  }
}

async function materializeApplication(
  admin: AdminClient,
  userId: string,
  artifact: { id: string; type: string; job_id: string | null },
  text: string,
  _version: number,
  input: QueueInput
): Promise<Materialized> {
  if (artifact.type !== 'cover_letter' && artifact.type !== 'resume') {
    return { ok: false, error: `A ${artifact.type.replace('_', ' ')} cannot go out with an application.`, fix: 'Use a cover_letter or resume artifact.' }
  }
  const jobId = input.jobId ?? artifact.job_id
  if (!jobId) return { ok: false, error: 'There is no role to apply to.', fix: 'Pass job_id, or use a document that was written for a role.' }
  const { data: owned } = await ownedJobsQuery(admin, userId, 'id').eq('id', jobId).maybeSingle()
  if (!owned) return { ok: false, error: `No role with id ${jobId}.`, fix: 'Call find_roles and use an id it returned.' }

  const field = artifact.type === 'cover_letter' ? 'cover_letter' : 'resume_summary'
  const { data: existing } = await admin.from('application_drafts').select('id, status').eq('user_id', userId).eq('job_id', jobId).in('status', ['pending_review']).limit(1)
  const draft = ((existing as { id: string }[] | null) ?? [])[0]
  let id: string
  if (draft) {
    id = draft.id
    await admin.from('application_drafts').update({ [field]: text, updated_at: new Date().toISOString() }).eq('id', id)
  } else {
    const { data, error } = await admin.from('application_drafts').insert({ user_id: userId, job_id: jobId, status: 'pending_review', [field]: text }).select('id').single()
    if (error || !data) return { ok: false, error: `Could not prepare the application: ${error?.message ?? 'no row'}`, fix: 'Try again.' }
    id = (data as { id: string }).id
  }
  return { ok: true, target: { table: 'application_drafts', id, payload: { job_id: jobId, [field]: text } } }
}

// --- decide -------------------------------------------------------------------------

export interface DecideInput {
  /** The person's own client (RLS) and session. For a rule these are the service client and null. */
  supabase: SupabaseClient
  admin: AdminClient
  user: { id: string; email?: string | null; identities?: { provider: string }[] | null }
  session: { provider_token?: string | null } | null
  id: string
  decision: 'approve' | 'skip'
  by: 'user' | 'rule'
  /** The person edited the words before approving. Becomes a new version with the person as author. */
  edits?: { subject?: string; body?: string; text?: string }
  /** The person has seen this version and approves it, though it is newer than the one queued. */
  acknowledgeVersion?: number
}

export interface DecideResult {
  /** HTTP status the route returns. */
  status: number
  approval: ApprovalRow | null
  /** The line the UI shows. */
  copy: string
  error?: string
  fix?: string
}

async function load(admin: AdminClient, userId: string, id: string): Promise<ApprovalRow | null> {
  const { data } = await admin.from('approvals').select(COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle()
  return (data as ApprovalRow | null) ?? null
}

/** Move a row forward from one of `from` to `to`, in one conditional update. Returns the row only for the caller that won. */
async function claim(admin: AdminClient, userId: string, id: string, from: ApprovalStatus[], patch: Record<string, unknown>): Promise<ApprovalRow | null> {
  const { data } = await admin.from('approvals').update(patch).eq('id', id).eq('user_id', userId).in('status', from).select(COLUMNS)
  return ((data as ApprovalRow[] | null) ?? [])[0] ?? null
}

const when = (d = new Date()) => d.toISOString()

export async function decideApproval(input: DecideInput): Promise<DecideResult> {
  const { admin, user } = input
  const current = await load(admin, user.id, input.id)
  if (!current) return { status: 404, approval: null, copy: 'That approval was not found.', error: 'Not found', fix: 'Open Needs you and choose one from the list.' }

  // A repeat call returns what already happened.
  if (current.status === 'done' || current.status === 'failed' || current.status === 'skipped') return finished(current)
  if (current.status === 'executing') return { status: 409, approval: current, copy: 'This is already being sent.', error: 'In progress', fix: 'Wait a moment and check again.' }

  if (input.decision === 'skip') {
    const row = await claim(admin, user.id, current.id, ['pending'], { status: 'skipped', decided_by: input.by, decided_at: when() })
    if (!row) return finished((await load(admin, user.id, current.id)) ?? current)
    await markTarget(admin, user.id, row, 'skipped')
    if (row.trace_id) void scoreTrace(row.trace_id, 'draft_skipped', 0)
    return { status: 200, approval: row, copy: SKIPPED_COPY }
  }

  // Approve. Edits first: they become a new version, and the hash follows them.
  let pending = current
  if (input.edits) {
    const edited = await applyEdits(admin, user.id, current, input.edits)
    if (!edited.ok) return { status: 422, approval: current, copy: edited.error, error: edited.error, fix: edited.fix }
    pending = edited.approval
  }
  const stale = await checkCurrent(admin, user.id, pending, input.acknowledgeVersion)
  if (!stale.ok) return { status: 409, approval: pending, copy: STALE_COPY, error: STALE_COPY, fix: stale.fix }
  pending = stale.approval

  // One conditional update decides who runs it. The loser reads the winner's result.
  const claimed = await claim(admin, user.id, pending.id, ['pending'], { status: 'executing', decided_by: input.by, decided_at: when(), error: null })
  if (!claimed) {
    const latest = (await load(admin, user.id, pending.id)) ?? pending
    return latest.status === 'executing' ? { status: 409, approval: latest, copy: 'This is already being sent.', error: 'In progress', fix: 'Wait a moment and check again.' } : finished(latest)
  }
  return execute(input, claimed)
}

function finished(row: ApprovalRow): DecideResult {
  const copy = row.status === 'skipped' ? SKIPPED_COPY : row.status === 'failed' ? (row.error ?? 'Not sent.') : (row.outcome?.what ?? 'Done.')
  return { status: 200, approval: row, copy }
}

async function execute(input: DecideInput, row: ApprovalRow): Promise<DecideResult> {
  const { admin, user } = input
  let ok = false
  let what = ''
  let result: Record<string, unknown> = {}
  let error: string | null = null

  try {
    if (row.action === 'send_email') {
      const sent = await sendOutreach({
        supabase: input.supabase,
        admin: () => admin,
        user,
        session: input.session,
        readBody: async () => ({ id: row.target_id, approve: true }),
      })
      ok = sent.status === 200 && sent.body.ok === true
      const message = sent.body.message as { id?: string; to_name?: string | null; to_email?: string; gmail_message_id?: string | null } | null | undefined
      what = ok ? `Email sent to ${message?.to_name ?? message?.to_email ?? 'the contact'}` : ''
      result = { http: sent.status, gmail_message_id: message?.gmail_message_id ?? null, from: user.email ?? null, ...(sent.body.warning ? { warning: sent.body.warning } : {}) }
      if (!ok) error = sent.body.needsReauth ? GMAIL_REAUTH_COPY : `Not sent: ${String(sent.body.error ?? sent.body.reason ?? 'something went wrong').slice(0, 300)}`
    } else {
      const submitted = await approveDraft({ admin, userId: user.id, draftId: row.target_id })
      const status = submitted.body.status
      ok = submitted.status === 200 && submitted.body.ok === true && status !== 'failed'
      what = status === 'submitted' ? 'Application submitted' : 'Application approved. Finish it on the company site.'
      result = { http: submitted.status, status, provider: submitted.body.provider ?? null, handoff_url: submitted.body.handoffUrl ?? null, submission_ref: submitted.body.submissionRef ?? null }
      if (!ok) error = `Not submitted: ${String(submitted.body.error ?? 'something went wrong').slice(0, 300)}`
    }
  } catch (e) {
    // A thrown send or submit must still end the row, or it would stay "executing" and block a retry.
    ok = false
    error = `Not sent: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`
  }

  const outcome: Outcome | null = ok ? { what, when: when(), artifact_version: row.artifact_version, approval_id: row.id, result } : null
  const { data } = await admin
    .from('approvals')
    .update({ status: ok ? 'done' : 'failed', executed_at: when(), outcome, error })
    .eq('id', row.id)
    .eq('user_id', user.id)
    .select(COLUMNS)
    .single()
  const done = (data as ApprovalRow | null) ?? { ...row, status: ok ? ('done' as const) : ('failed' as const), outcome, error }
  if (row.trace_id) void scoreTrace(row.trace_id, ok ? 'draft_approved' : 'draft_skipped', ok ? 1 : 0, ok ? what : 'send failed')
  return { status: 200, approval: done, copy: ok ? outcomeCopy(done, user.email ?? null) : (error ?? 'Not sent.') }
}

/** "Sent from you@gmail.com at 9:41. Saved." */
export function outcomeCopy(row: ApprovalRow, from: string | null): string {
  const time = row.outcome?.when ? new Date(row.outcome.when).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false }).replace(/^0/, '') : ''
  if (row.action === 'send_email') return `Sent${from ? ` from ${from}` : ''}${time ? ` at ${time}` : ''}. Saved.`
  return `${row.outcome?.what ?? 'Done'}${time ? ` at ${time}` : ''}. Saved.`
}

async function markTarget(admin: AdminClient, userId: string, row: ApprovalRow, outcome: 'skipped'): Promise<void> {
  try {
    if (row.target_table === 'outreach_messages') await updateOutreach(admin as unknown as SupabaseClient, userId, row.target_id, { status: outcome })
    else await admin.from('application_drafts').update({ status: 'rejected', updated_at: when() }).eq('id', row.target_id).eq('user_id', userId)
  } catch {
    // The approval row is the record; the draft will be tidied when the person next opens it.
  }
}

// --- edits and staleness ------------------------------------------------------------

async function applyEdits(
  admin: AdminClient,
  userId: string,
  row: ApprovalRow,
  edits: NonNullable<DecideInput['edits']>
): Promise<{ ok: true; approval: ApprovalRow } | { ok: false; error: string; fix: string }> {
  const got = await getArtifact(admin, userId, row.artifact_id)
  if (!got) return { ok: false, error: 'The draft no longer exists.', fix: 'Ask Cello to write it again.' }
  const content = { ...(got.version.content as Record<string, unknown>) }
  if (row.target_table === 'outreach_messages') {
    if (edits.subject !== undefined) content.subject = edits.subject
    if (edits.body !== undefined) content.body = edits.body
  } else if (edits.text !== undefined) {
    content.text = edits.text
  }
  const versionNumber = await addVersion(admin, { userId, artifactId: row.artifact_id, author: 'user', content, note: 'Edited before approving' })
  const refreshed = await getArtifact(admin, userId, row.artifact_id, { version: versionNumber })
  if (!refreshed) return { ok: false, error: 'Could not save your edit.', fix: 'Try again.' }
  const target = await syncTarget(admin, userId, row, refreshed.version.content as Record<string, unknown>)
  const { data } = await admin
    .from('approvals')
    .update({ artifact_version: versionNumber, payload_hash: hash(payloadFor(row.action, versionNumber, {}, target)) })
    .eq('id', row.id)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select(COLUMNS)
  const next = ((data as ApprovalRow[] | null) ?? [])[0]
  return next ? { ok: true, approval: next } : { ok: false, error: 'This approval was already decided.', fix: 'Open Needs you for its result.' }
}

/** Write the person's edit into the row the send or submit path reads, and return the payload that is hashed. */
async function syncTarget(admin: AdminClient, userId: string, row: ApprovalRow, content: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (row.target_table === 'outreach_messages') {
    const { data } = await admin.from('outreach_messages').update({ subject: content.subject, body: content.body }).eq('id', row.target_id).eq('user_id', userId).select('to_email, kind').single()
    const m = data as { to_email: string; kind: string } | null
    return { subject: content.subject, body: content.body, to_email: m?.to_email, kind: m?.kind }
  }
  const field = typeof content.text === 'string' ? 'text' : ''
  const { data: draft } = await admin.from('application_drafts').select('job_id, cover_letter, resume_summary').eq('id', row.target_id).eq('user_id', userId).single()
  const d = draft as { job_id: string; cover_letter: string | null; resume_summary: string | null } | null
  const column = d?.cover_letter !== null && d?.cover_letter !== undefined ? 'cover_letter' : 'resume_summary'
  if (field) await admin.from('application_drafts').update({ [column]: content.text }).eq('id', row.target_id).eq('user_id', userId)
  return { job_id: d?.job_id, [column]: content.text }
}

async function checkCurrent(
  admin: AdminClient,
  userId: string,
  row: ApprovalRow,
  acknowledge?: number
): Promise<{ ok: true; approval: ApprovalRow } | { ok: false; fix: string }> {
  const got = await getArtifact(admin, userId, row.artifact_id)
  if (!got) return { ok: false, fix: 'The draft no longer exists. Ask Cello to write it again.' }
  if (got.version.version === row.artifact_version) return { ok: true, approval: row }
  // The draft changed after it was queued. The person must have seen the new one.
  if (acknowledge !== got.version.version) {
    return { ok: false, fix: `Show the person version ${got.version.version}, then approve with acknowledge_version ${got.version.version}.` }
  }
  const target = await syncTarget(admin, userId, row, got.version.content as Record<string, unknown>)
  const { data } = await admin
    .from('approvals')
    .update({ artifact_version: got.version.version, payload_hash: hash(payloadFor(row.action, got.version.version, {}, target)) })
    .eq('id', row.id)
    .eq('user_id', userId)
    .eq('status', 'pending')
    .select(COLUMNS)
  const next = ((data as ApprovalRow[] | null) ?? [])[0]
  return next ? { ok: true, approval: next } : { ok: false, fix: 'This approval was already decided.' }
}

// --- rules --------------------------------------------------------------------------

export interface RuleTask {
  autonomy: Autonomy
  rules: AutonomyRules
}

/**
 * Whether a task's stored rules allow approving this on its own. Only "act within my
 * rules" can, only for what the rules name, and never an application unless allow_submit is set.
 */
export function ruleAllows(task: RuleTask, action: ApprovalAction): boolean {
  if (task.autonomy !== 'act') return false
  return action === 'send_email' ? task.rules.allow_send_email === true : task.rules.allow_submit === true
}

/** Approve by rule, through the same code as the person's click. A task that does not allow it leaves the row pending. */
export async function autoApprove(
  task: RuleTask,
  approval: ApprovalRow,
  deps: { supabase: SupabaseClient; admin: AdminClient; user: DecideInput['user'] }
): Promise<DecideResult | null> {
  if (!ruleAllows(task, approval.action)) return null
  return decideApproval({ ...deps, session: null, id: approval.id, decision: 'approve', by: 'rule' })
}

// --- telling the conversation -------------------------------------------------------

export interface ApprovalEvent {
  id: string
  text: string
}

/** Results of approvals decided since the last turn, to tell the conversation. Marks them posted. */
export async function takeUnpostedResults(admin: AdminClient, userId: string, threadId: string): Promise<ApprovalEvent[]> {
  const { data } = await admin
    .from('approvals')
    .select(COLUMNS)
    .eq('user_id', userId)
    .eq('thread_id', threadId)
    .is('posted_at', null)
    .in('status', ['done', 'failed', 'skipped'])
  const rows = (data as ApprovalRow[] | null) ?? []
  const events: ApprovalEvent[] = []
  for (const row of rows) {
    // One conditional update per row: two turns starting at once tell the conversation once.
    const { data: won } = await admin.from('approvals').update({ posted_at: when() }).eq('id', row.id).is('posted_at', null).select('id')
    if (((won as unknown[] | null) ?? []).length === 0) continue
    events.push({ id: row.id, text: eventText(row) })
  }
  return events
}

export function eventText(row: ApprovalRow): string {
  const what = row.action === 'send_email' ? 'email' : 'application'
  if (row.status === 'skipped') return `The person skipped the ${what}. Nothing was sent.`
  if (row.status === 'failed') return `The ${what} was not sent. ${row.error ?? ''}`.trim()
  return `The person approved the ${what}. ${row.outcome?.what ?? 'Done'}${row.outcome?.when ? ` at ${row.outcome.when}` : ''}.`
}
