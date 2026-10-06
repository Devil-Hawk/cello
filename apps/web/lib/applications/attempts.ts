// CRUD for public.application_attempts + the side effects a new attempt has
// on its parent public.applications row.
//
// The table is not in @cello/shared's generated Database type, so this uses
// an untyped SupabaseClient with the row shape from ./types.ts — the same
// convention as lib/resume/store.ts and lib/dossier/store.ts.
//
// WHICH CLIENT TO PASS
//   Pass the service-role admin client (lib/harness/supabase-admin.ts
//   createAdminClient()) from API routes. Because service-role BYPASSES RLS,
//   every function here filters on `user_id` explicitly — that predicate is
//   the only thing standing between users, so never remove it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ApplicationActivity,
  ApplicationAttempt,
  ApplicationAttemptRow,
  NewAttemptInput,
  AttemptPatch,
  AttemptProvenance,
  AttemptVerificationState,
} from './types'
import { toApplicationAttempt } from './types'
import { recordInteraction } from '../interactions/store'
import { DATA_URL_RE } from './attempt-rules'

const ATTEMPTS_TABLE = 'application_attempts'
const APPLICATIONS_TABLE = 'applications'
const ACTIVITIES_TABLE = 'activities'
const ACTIVITIES_LIMIT = 50
const SCREENSHOT_BUCKET = 'attempts'
/** The bucket takes JPEG up to 256 KB (migration 20261013000000). */
const SCREENSHOT_MAX_BYTES = 262144

/**
 * Move one attempt's data-URL screenshot into the private bucket and point the row at it. Only a JPEG
 * that fits the bucket's limit moves; anything else stays a data URL on the row.
 * ponytail: PNG, WebP and large images stay as data URLs. Upgrade: re-encode with sharp before upload.
 * Returns the path, or null when nothing moved. Never throws: the attempt is saved either way.
 */
async function moveScreenshot(
  client: SupabaseClient,
  row: { id: string; user_id: string; confirmation_attachment_url: string | null }
): Promise<string | null> {
  const url = row.confirmation_attachment_url
  const match = url ? DATA_URL_RE.exec(url) : null
  if (!url || !match || !/^data:image\/jpe?g;/i.test(url)) return null
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length > SCREENSHOT_MAX_BYTES) return null
  const path = `${row.user_id}/${row.id}.jpg`
  const up = await client.storage.from(SCREENSHOT_BUCKET).upload(path, bytes, { contentType: 'image/jpeg', upsert: true })
  if (up.error) return null
  const { error } = await client
    .from(ATTEMPTS_TABLE)
    .update({ screenshot_path: path, confirmation_attachment_url: null })
    .eq('id', row.id)
    .eq('user_id', row.user_id)
  return error ? null : path
}

export interface MoveResult {
  moved: number
  /** Not a JPEG, or over 256 KB: left as a data URL. */
  left: number
  failed: number
}

/** Move the data-URL screenshots of saved attempts into the bucket, `limit` rows a call. */
export async function moveDataUrlImages(client: SupabaseClient, limit = 200): Promise<MoveResult> {
  const { data, error } = await client
    .from(ATTEMPTS_TABLE)
    .select('id, user_id, confirmation_attachment_url')
    .is('screenshot_path', null)
    .like('confirmation_attachment_url', 'data:%')
    .limit(limit)
  if (error) throw new Error(`moveDataUrlImages failed: ${error.message}`)
  const result: MoveResult = { moved: 0, left: 0, failed: 0 }
  for (const row of (data as Array<{ id: string; user_id: string; confirmation_attachment_url: string | null }>) ?? []) {
    const url = row.confirmation_attachment_url ?? ''
    const match = DATA_URL_RE.exec(url)
    if (!match || !/^data:image\/jpe?g;/i.test(url) || Buffer.from(match[2], 'base64').length > SCREENSHOT_MAX_BYTES) {
      result.left++
    } else if (await moveScreenshot(client, row)) {
      result.moved++
    } else {
      result.failed++
    }
  }
  return result
}

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

/** Insert a new attempt row. `provenance` and `verificationState` are
 *  explicit PARAMETERS, not read off `input` — callers (the API route)
 *  decide those, so a client-supplied body can never smuggle a stronger
 *  claim than it's entitled to (see attempt-rules.ts's header).
 *
 *  `application` is the OwnedApplication every caller has already loaded
 *  (to validate ownership before calling this) — passed through rather than
 *  re-fetched so this function can resolve the attempt's company for the
 *  STEP 5 interactions projection without a redundant applications read. */
export async function createAttempt(
  client: SupabaseClient,
  userId: string,
  input: NewAttemptInput,
  provenance: AttemptProvenance,
  verificationState: AttemptVerificationState,
  application: OwnedApplication,
  sourceDetail: Record<string, unknown> | null = null
): Promise<ApplicationAttempt> {
  const row = {
    application_id: input.applicationId,
    job_id: application.job_id,
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
  const { data, error } = await client.from(ATTEMPTS_TABLE).insert(row).select('*').single()
  if (error) throw new Error(`createAttempt failed: ${error.message}`)
  const attempt = toApplicationAttempt(data as ApplicationAttemptRow)
  // New uploads go to the bucket; the row keeps the data URL if the move does not work.
  const stored = await moveScreenshot(client, data as ApplicationAttemptRow)
  if (stored) Object.assign(attempt, { screenshotPath: stored, confirmationAttachmentUrl: null })

  const { data: job } = await client
    .from('person_jobs')
    .select('company_id:viewer_company_id')
    .eq('viewer_id', userId)
    .eq('id', application.job_id)
    .maybeSingle()

  await recordInteraction(client, {
    userId,
    companyId: (job as { company_id: string | null } | null)?.company_id ?? null,
    jobId: application.job_id,
    applicationId: attempt.applicationId,
    kind: 'application_submitted',
    occurredAt: attempt.submittedAt,
    title: `Application submitted — ${input.destination}`,
    refTable: ATTEMPTS_TABLE,
    refId: attempt.id,
    metadata: { provenance, verification_state: verificationState },
  })

  return attempt
}

/** Every attempt for one application, newest submission first. */
export async function listAttempts(
  client: SupabaseClient,
  userId: string,
  applicationId: string
): Promise<ApplicationAttempt[]> {
  const { data, error } = await client
    .from(ATTEMPTS_TABLE)
    .select('*')
    .eq('user_id', userId)
    .eq('application_id', applicationId)
    .order('submitted_at', { ascending: false })
  if (error) throw new Error(`listAttempts failed: ${error.message}`)
  return ((data as ApplicationAttemptRow[]) ?? []).map(toApplicationAttempt)
}

/** The activity timeline for one application, newest first, capped — the
 *  real conversation history (Gmail-detected signal today) that the
 *  notifications page already reads, surfaced here per-application. No
 *  user_id filter: activities has no such column, so the caller MUST have
 *  already scoped `applicationId` to this user via getOwnedApplication. */
export async function listActivities(
  client: SupabaseClient,
  applicationId: string
): Promise<ApplicationActivity[]> {
  const { data, error } = await client
    .from(ACTIVITIES_TABLE)
    .select('id, application_id, type, title, description, metadata, occurred_at')
    .eq('application_id', applicationId)
    .order('occurred_at', { ascending: false })
    .limit(ACTIVITIES_LIMIT)
  if (error) throw new Error(`listActivities failed: ${error.message}`)
  return (data as ApplicationActivity[]) ?? []
}

/** One attempt by id, scoped to its owner. */
export async function getAttempt(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<ApplicationAttempt | null> {
  const { data, error } = await client
    .from(ATTEMPTS_TABLE)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getAttempt failed: ${error.message}`)
  return data ? toApplicationAttempt(data as ApplicationAttemptRow) : null
}

/** Patch an attempt's user-correctable fields. Never touches provenance or
 *  verification_state — see AttemptPatch's doc comment for why a correction
 *  to an asserted fact stays an assertion. Returns null if the row doesn't
 *  exist or isn't owned by this user. */
export async function updateAttempt(
  client: SupabaseClient,
  userId: string,
  id: string,
  patch: AttemptPatch
): Promise<ApplicationAttempt | null> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.submittedAt !== undefined) fields.submitted_at = patch.submittedAt
  if (patch.destination !== undefined) fields.destination = patch.destination
  if (patch.documents !== undefined) fields.documents = patch.documents
  if (patch.confirmationIdentifier !== undefined) fields.confirmation_identifier = patch.confirmationIdentifier
  if (patch.confirmationNote !== undefined) fields.confirmation_note = patch.confirmationNote
  if (patch.confirmationAttachmentUrl !== undefined) fields.confirmation_attachment_url = patch.confirmationAttachmentUrl

  const { data, error } = await client
    .from(ATTEMPTS_TABLE)
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
    .eq('provenance', 'manual')
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`updateAttempt failed: ${error.message}`)
  return data ? toApplicationAttempt(data as ApplicationAttemptRow) : null
}

/** Delete one attempt. Idempotent — deleting an already-gone/foreign id is
 *  not an error, matching lib/resume/store.ts's deleteVersion. */
export async function deleteAttempt(client: SupabaseClient, userId: string, id: string): Promise<void> {
  // Only the person's own entry can be removed; what Cello or the extension recorded keeps its record.
  const { error } = await client.from(ATTEMPTS_TABLE).delete().eq('id', id).eq('user_id', userId).eq('provenance', 'manual')
  if (error) throw new Error(`deleteAttempt failed: ${error.message}`)
}

/** How an attempt's provenance reads onto applications.source, the FIRST time
 *  something concrete is known (see syncApplicationFromAttempt — this never
 *  overwrites an existing, more specific source). */
const SOURCE_FOR_PROVENANCE: Record<AttemptProvenance, string> = {
  manual: 'manual',
  ats_direct: 'cello-autopilot',
  browser_companion: 'browser_companion',
}

/**
 * Reflect a newly-created attempt onto its parent `applications` row:
 *   - fills `applied_at` from the attempt's submitted_at, but only if the
 *     application doesn't already have one (a correction attempt must not
 *     silently change an already-known applied date).
 *   - sets `stage` when the caller asked for one — this is a first-class
 *     manual stage correction, the same as the pipeline board's drag/menu
 *     path, not a fallback bolted on for when automation fails.
 *   - sets `source` only when it is currently null — a manual attempt added
 *     later to correct/annotate an application that Cello's own autopilot
 *     or Gmail sync already originated must never overwrite that history.
 * Best-effort in the sense that partial failure of one field must not lose
 * the others; each write is independent.
 */
export async function syncApplicationFromAttempt(
  client: SupabaseClient,
  userId: string,
  application: OwnedApplication,
  attempt: Pick<ApplicationAttempt, 'submittedAt' | 'provenance'>,
  stage?: string | null
): Promise<void> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (!application.applied_at) fields.applied_at = attempt.submittedAt
  if (!application.source) fields.source = SOURCE_FOR_PROVENANCE[attempt.provenance]
  if (stage && stage !== application.stage) fields.stage = stage

  // Nothing beyond updated_at to change — skip the write entirely.
  if (Object.keys(fields).length === 1) return

  const { error } = await client
    .from(APPLICATIONS_TABLE)
    .update(fields)
    .eq('id', application.id)
    .eq('user_id', userId)
  if (error) throw new Error(`syncApplicationFromAttempt failed: ${error.message}`)
}
