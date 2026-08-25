// CRUD for public.application_receipts + the side effects a new receipt has
// on its parent public.applications row.
//
// The table is not in @cello/shared's generated Database type, so this uses
// an untyped SupabaseClient with the row shape from ./types.ts — the same
// convention as lib/resume/store.ts and lib/interview/store.ts.
//
// WHICH CLIENT TO PASS
//   Pass the service-role admin client (lib/harness/supabase-admin.ts
//   createAdminClient()) from API routes. Because service-role BYPASSES RLS,
//   every function here filters on `user_id` explicitly — that predicate is
//   the only thing standing between users, so never remove it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ApplicationReceipt,
  ApplicationReceiptRow,
  NewReceiptInput,
  ReceiptPatch,
  ReceiptProvenance,
  ReceiptVerificationState,
} from './types'
import { toApplicationReceipt } from './types'

const RECEIPTS_TABLE = 'application_receipts'
const APPLICATIONS_TABLE = 'applications'

export interface OwnedApplication {
  id: string
  user_id: string
  job_id: string
  stage: string
  applied_at: string | null
  source: string | null
}

/** Load an applications row, scoped to its owner. Returns null if it doesn't
 *  exist or isn't this user's — the two cases a caller should treat
 *  identically (never leak which one it was). */
export async function getOwnedApplication(
  client: SupabaseClient,
  userId: string,
  applicationId: string
): Promise<OwnedApplication | null> {
  const { data, error } = await client
    .from(APPLICATIONS_TABLE)
    .select('id, user_id, job_id, stage, applied_at, source')
    .eq('id', applicationId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getOwnedApplication failed: ${error.message}`)
  return (data as OwnedApplication | null) ?? null
}

/** Insert a new receipt row. `provenance` and `verificationState` are
 *  explicit PARAMETERS, not read off `input` — callers (the API route)
 *  decide those, so a client-supplied body can never smuggle a stronger
 *  claim than it's entitled to (see receipts.ts's header). */
export async function createReceipt(
  client: SupabaseClient,
  userId: string,
  input: NewReceiptInput,
  provenance: ReceiptProvenance,
  verificationState: ReceiptVerificationState,
  sourceDetail: Record<string, unknown> | null = null
): Promise<ApplicationReceipt> {
  const row = {
    application_id: input.applicationId,
    user_id: userId,
    provenance,
    verification_state: verificationState,
    submitted_at: input.submittedAt,
    destination: input.destination,
    documents: input.documents,
    confirmation_identifier: input.confirmationIdentifier ?? null,
    confirmation_note: input.confirmationNote ?? null,
    confirmation_attachment_url: input.confirmationAttachmentUrl ?? null,
    source_detail: sourceDetail,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await client.from(RECEIPTS_TABLE).insert(row).select('*').single()
  if (error) throw new Error(`createReceipt failed: ${error.message}`)
  return toApplicationReceipt(data as ApplicationReceiptRow)
}

/** Every receipt for one application, newest submission first. */
export async function listReceipts(
  client: SupabaseClient,
  userId: string,
  applicationId: string
): Promise<ApplicationReceipt[]> {
  const { data, error } = await client
    .from(RECEIPTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('application_id', applicationId)
    .order('submitted_at', { ascending: false })
  if (error) throw new Error(`listReceipts failed: ${error.message}`)
  return ((data as ApplicationReceiptRow[]) ?? []).map(toApplicationReceipt)
}

/** One receipt by id, scoped to its owner. */
export async function getReceipt(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<ApplicationReceipt | null> {
  const { data, error } = await client
    .from(RECEIPTS_TABLE)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getReceipt failed: ${error.message}`)
  return data ? toApplicationReceipt(data as ApplicationReceiptRow) : null
}

/** Patch a receipt's user-correctable fields. Never touches provenance or
 *  verification_state — see ReceiptPatch's doc comment for why a correction
 *  to an asserted fact stays an assertion. Returns null if the row doesn't
 *  exist or isn't owned by this user. */
export async function updateReceipt(
  client: SupabaseClient,
  userId: string,
  id: string,
  patch: ReceiptPatch
): Promise<ApplicationReceipt | null> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.submittedAt !== undefined) fields.submitted_at = patch.submittedAt
  if (patch.destination !== undefined) fields.destination = patch.destination
  if (patch.documents !== undefined) fields.documents = patch.documents
  if (patch.confirmationIdentifier !== undefined) fields.confirmation_identifier = patch.confirmationIdentifier
  if (patch.confirmationNote !== undefined) fields.confirmation_note = patch.confirmationNote
  if (patch.confirmationAttachmentUrl !== undefined) fields.confirmation_attachment_url = patch.confirmationAttachmentUrl

  const { data, error } = await client
    .from(RECEIPTS_TABLE)
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`updateReceipt failed: ${error.message}`)
  return data ? toApplicationReceipt(data as ApplicationReceiptRow) : null
}

/** Delete one receipt. Idempotent — deleting an already-gone/foreign id is
 *  not an error, matching lib/resume/store.ts's deleteVersion. */
export async function deleteReceipt(client: SupabaseClient, userId: string, id: string): Promise<void> {
  const { error } = await client.from(RECEIPTS_TABLE).delete().eq('id', id).eq('user_id', userId)
  if (error) throw new Error(`deleteReceipt failed: ${error.message}`)
}

/** How a receipt's provenance reads onto applications.source, the FIRST time
 *  something concrete is known (see syncApplicationFromReceipt — this never
 *  overwrites an existing, more specific source). */
const SOURCE_FOR_PROVENANCE: Record<ReceiptProvenance, string> = {
  manual: 'manual',
  ats_direct: 'cello-autopilot',
  browser_companion: 'browser_companion',
}

/**
 * Reflect a newly-created receipt onto its parent `applications` row:
 *   - fills `applied_at` from the receipt's submitted_at, but only if the
 *     application doesn't already have one (a correction receipt must not
 *     silently change an already-known applied date).
 *   - sets `stage` when the caller asked for one — this is a first-class
 *     manual stage correction, the same as the pipeline board's drag/menu
 *     path, not a fallback bolted on for when automation fails.
 *   - sets `source` only when it is currently null — a manual receipt added
 *     later to correct/annotate an application that Cello's own autopilot
 *     or Gmail sync already originated must never overwrite that history.
 * Best-effort in the sense that partial failure of one field must not lose
 * the others; each write is independent.
 */
export async function syncApplicationFromReceipt(
  client: SupabaseClient,
  userId: string,
  application: OwnedApplication,
  receipt: Pick<ApplicationReceipt, 'submittedAt' | 'provenance'>,
  stage?: string | null
): Promise<void> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (!application.applied_at) fields.applied_at = receipt.submittedAt
  if (!application.source) fields.source = SOURCE_FOR_PROVENANCE[receipt.provenance]
  if (stage && stage !== application.stage) fields.stage = stage

  // Nothing beyond updated_at to change — skip the write entirely.
  if (Object.keys(fields).length === 1) return

  const { error } = await client
    .from(APPLICATIONS_TABLE)
    .update(fields)
    .eq('id', application.id)
    .eq('user_id', userId)
  if (error) throw new Error(`syncApplicationFromReceipt failed: ${error.message}`)
}
