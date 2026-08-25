// CRUD for public.resume_documents.
//
// The table is not in @cello/shared's generated Database type, so this uses an
// untyped SupabaseClient with the row shape from ./types.ts — the same
// convention as lib/interview/store.ts and lib/dossier/store.ts.
//
// WHICH CLIENT TO PASS
//   Pass the service-role admin client (lib/harness/supabase-admin.ts
//   createAdminClient()) from API routes and agents. Because service-role
//   BYPASSES RLS, every function here filters on `user_id` explicitly — that
//   predicate is the only thing standing between users, so never remove it. The
//   cookie-scoped RLS client also works (reads get filtered twice, harmlessly).
//
// APPEND-ONLY BY DESIGN
//   Content is never updated in place. createVersion() appends a new numbered
//   snapshot so the resume studio can diff and roll back. Only metadata
//   (title, ats_score) is patchable, via updateVersionMeta().

import type { SupabaseClient } from '@supabase/supabase-js'
import { markdownToPlainText } from './markdown'
import { DEFAULT_TEMPLATE_ID } from './templates'
import { toResumeContentJson } from './types'
import type {
  NewResumeVersion,
  ResumeContentJson,
  ResumeDocument,
  ResumeVersionPatch,
} from './types'

const TABLE = 'resume_documents'

/** Postgres unique-violation SQLSTATE, raised when two writers race on a version. */
const UNIQUE_VIOLATION = '23505'

/** How many times createVersion() re-reads max(version) after losing a race. */
const VERSION_RETRIES = 4

/** Hard ceiling on listVersions(), so a bad `limit` can never scan the table. */
const MAX_LIST_LIMIT = 200

/**
 * The newest version in a bucket, or null when the bucket is empty.
 * Pass `jobId = null` for the base resume.
 */
export async function getLatestVersion(
  client: SupabaseClient,
  userId: string,
  jobId: string | null
): Promise<ResumeDocument | null> {
  const base = client.from(TABLE).select('*').eq('user_id', userId)
  // CRITICAL: PostgREST renders `.eq('job_id', null)` as `job_id=eq.null`, which
  // matches NOTHING. The base-resume bucket must use `.is('job_id', null)`.
  const scoped = jobId ? base.eq('job_id', jobId) : base.is('job_id', null)

  const { data, error } = await scoped
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`getLatestVersion failed: ${error.message}`)
  return (data as ResumeDocument | null) ?? null
}

/**
 * Every version in a bucket, newest first. Pass `jobId = null` for the base
 * resume. `limit` is clamped to 1..200.
 */
export async function listVersions(
  client: SupabaseClient,
  userId: string,
  jobId: string | null,
  opts: { limit?: number } = {}
): Promise<ResumeDocument[]> {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? 50))
  const base = client.from(TABLE).select('*').eq('user_id', userId)
  // See getLatestVersion: null job_id needs `.is`, not `.eq`.
  const scoped = jobId ? base.eq('job_id', jobId) : base.is('job_id', null)

  const { data, error } = await scoped
    .order('version', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listVersions failed: ${error.message}`)
  return (data as ResumeDocument[]) ?? []
}

/**
 * The current base resume — the newest version with `job_id IS NULL`.
 * Returns null when the user has never saved one (fall back to
 * `profiles.resume_text` in that case).
 */
export async function getBaseResume(
  client: SupabaseClient,
  userId: string
): Promise<ResumeDocument | null> {
  return getLatestVersion(client, userId, null)
}

/** One version by id, scoped to its owner. */
export async function getVersionById(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<ResumeDocument | null> {
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`getVersionById failed: ${error.message}`)
  return (data as ResumeDocument | null) ?? null
}

/**
 * Append a new version to a bucket. `version` is assigned as
 * max(version) + 1 for (user_id, job_id) — callers never supply it.
 *
 * CONCURRENCY: read-max-then-insert is not atomic, so two simultaneous writers
 * can pick the same number. The DB rejects the loser via
 * unique_resume_version_per_job / uniq_resume_base_version, and this retries
 * with a freshly-read max up to VERSION_RETRIES times. That makes the operation
 * safe without a table lock or a sequence per bucket.
 */
export async function createVersion(
  client: SupabaseClient,
  input: NewResumeVersion
): Promise<ResumeDocument> {
  const content = input.content?.trim()
  if (!content) throw new Error('createVersion failed: content is empty')
  if (!input.userId) throw new Error('createVersion failed: userId is required')

  const jobId = input.jobId ?? null

  for (let attempt = 0; attempt <= VERSION_RETRIES; attempt++) {
    const latest = await getLatestVersion(client, input.userId, jobId)
    const version = (latest?.version ?? 0) + 1

    const row = {
      user_id: input.userId,
      job_id: jobId,
      draft_id: input.draftId ?? null,
      version,
      title: input.title ?? null,
      content,
      content_json: input.contentJson ?? null,
      ats_score: input.atsScore ?? null,
      // Default the provenance from the bucket: no job means this is a base doc.
      source: input.source ?? (jobId ? 'tailored' : 'base'),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await client.from(TABLE).insert(row).select('*').single()
    if (!error) return data as ResumeDocument

    const isRace = (error as { code?: string }).code === UNIQUE_VIOLATION
    if (!isRace || attempt === VERSION_RETRIES) {
      throw new Error(`createVersion failed: ${error.message}`)
    }
    // Lost the race — loop and re-read max(version).
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('createVersion failed: exhausted version retries')
}

/**
 * Append a version from AUTHORED Markdown, deriving everything else.
 *
 * WHY THIS EXISTS RATHER THAN EACH CALLER DOING IT
 *   lib/resume/types.ts is emphatic that `content_json.markdown` is authored and
 *   `content` is `markdownToPlainText(markdown)` — and that writing one without
 *   the other makes the exported PDF and the text an ATS reads describe
 *   different resumes. Every caller that "remembers" to do both is a caller that
 *   can forget. This one does both, in one place, and there is no way to call it
 *   that produces a divergent pair.
 *
 * createVersion()'s append-only semantics are untouched — this is a thin
 * wrapper that computes two fields and delegates.
 *
 * `templateId` is a plain string because it comes from storage or a request
 * body; getTemplate() degrades anything unrecognised at render time, so an
 * unknown id stored here can never break a render. Omit it to get the default.
 *
 * `baseContentJson` carries forward other keys an earlier version set (e.g.
 * `sections`). Omit it for a freshly imported document, where the previous
 * version's structure describes a different resume.
 */
export async function createMarkdownVersion(
  client: SupabaseClient,
  input: Omit<NewResumeVersion, 'content' | 'contentJson'> & {
    markdown: string
    templateId?: string | null
    baseContentJson?: ResumeContentJson | null
  }
): Promise<ResumeDocument> {
  const { markdown, templateId, baseContentJson, ...rest } = input
  return createVersion(client, {
    ...rest,
    content: markdownToPlainText(markdown),
    contentJson: toResumeContentJson(markdown, templateId || DEFAULT_TEMPLATE_ID, baseContentJson),
  })
}

/**
 * Patch metadata on an existing version. Deliberately cannot touch `content` —
 * a content change is a new version (see createVersion).
 */
export async function updateVersionMeta(
  client: SupabaseClient,
  userId: string,
  id: string,
  patch: ResumeVersionPatch
): Promise<ResumeDocument> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) fields.title = patch.title
  if (patch.atsScore !== undefined) fields.ats_score = patch.atsScore
  if (Object.keys(fields).length === 1) {
    throw new Error('updateVersionMeta failed: nothing to update')
  }

  const { data, error } = await client
    .from(TABLE)
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()
  if (error) throw new Error(`updateVersionMeta failed: ${error.message}`)
  return data as ResumeDocument
}

/**
 * Delete one version. Version numbers are NOT renumbered afterwards, so gaps
 * are expected and createVersion() still counts up from the surviving max.
 */
export async function deleteVersion(
  client: SupabaseClient,
  userId: string,
  id: string
): Promise<void> {
  const { error } = await client
    .from(TABLE)
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
  if (error) throw new Error(`deleteVersion failed: ${error.message}`)
}
