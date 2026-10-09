// CRUD for public.resume_documents.
//
// The table is not in @cello/shared's generated Database type, so this uses an
// untyped SupabaseClient with the row shape from ./types.ts — the same
// convention as lib/dossier/store.ts.
//
// WHICH CLIENT TO PASS
//   Pass the service-role admin client (lib/harness/supabase-admin.ts
//   createAdminClient()) from API routes and agents. Because service-role
//   BYPASSES RLS, every function here filters on `user_id` explicitly — that
//   predicate is the only thing standing between users, so never remove it. The
//   cookie-scoped RLS client also works (reads get filtered twice, harmlessly).
//
// APPEND-ONLY BY DESIGN
//   Content is never updated in place. createResumeVersion() appends a new
//   numbered snapshot so the resume studio can diff and roll back. Only
//   metadata (title, ats_score) is patchable, via updateVersionMeta().
//
// THE ONLY WRITER
//   createResumeVersion() takes a structured Resume, validates it, and derives
//   every stored field from it (content_json.markdown, templateId, `content`).
//   The raw row insert is private, so nothing can store a version whose plain
//   text, Markdown and structure disagree. store.guard.test.ts enforces this.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resumeToMarkdown, resumeToPlainText } from './render'
import { ResumeSchema, type Resume } from './schema'
import type {
  ResumeContentJson,
  ResumeDocument,
  ResumeSource,
  ResumeVersionPatch,
} from './types'

const TABLE = 'resume_documents'

/** Postgres unique-violation SQLSTATE, raised when two writers race on a version. */
const UNIQUE_VIOLATION = '23505'

/** How many times insertVersionRow() re-reads max(version) after losing a race. */
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

/** The two stored columns derived from one Resume. Also used by the demo seeder. */
export function deriveResumeColumns(resume: Resume): { content: string; content_json: ResumeContentJson } {
  return {
    content: resumeToPlainText(resume),
    content_json: {
      resume,
      markdown: resumeToMarkdown(resume),
      templateId: resume.meta.cello.templateId,
    },
  }
}

interface InsertRow {
  userId: string
  jobId: string | null
  draftId?: string | null
  title?: string | null
  content: string
  contentJson: ResumeContentJson
  atsScore?: number | null
  source?: ResumeSource | null
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
async function insertVersionRow(client: SupabaseClient, input: InsertRow): Promise<ResumeDocument> {
  const content = input.content?.trim()
  if (!content) throw new Error('createResumeVersion failed: content is empty')
  if (!input.userId) throw new Error('createResumeVersion failed: userId is required')

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
      content_json: input.contentJson,
      ats_score: input.atsScore ?? null,
      // Default the provenance from the bucket: no job means this is a base doc.
      source: input.source ?? (jobId ? 'tailored' : 'base'),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await client.from(TABLE).insert(row).select('*').single()
    if (!error) return data as ResumeDocument

    const isRace = (error as { code?: string }).code === UNIQUE_VIOLATION
    if (!isRace || attempt === VERSION_RETRIES) {
      throw new Error(`createResumeVersion failed: ${error.message}`)
    }
    // Lost the race — loop and re-read max(version).
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('createResumeVersion failed: exhausted version retries')
}

/**
 * Append a version from a structured Resume. The Resume is validated (throws
 * before any insert) and everything stored is derived from it, so there is no
 * way to call this that produces a divergent set of columns. A database
 * trigger mirrors the latest BASE version's `content` into profiles.resume_text.
 */
export async function createResumeVersion(
  client: SupabaseClient,
  input: {
    userId: string
    jobId: string | null
    resume: Resume
    source: ResumeSource
    title?: string | null
    atsScore?: number | null
    draftId?: string | null
  }
): Promise<ResumeDocument> {
  const resume = ResumeSchema.parse(input.resume)
  const { content, content_json } = deriveResumeColumns(resume)
  return insertVersionRow(client, {
    userId: input.userId,
    jobId: input.jobId,
    draftId: input.draftId,
    title: input.title,
    content,
    contentJson: content_json,
    atsScore: input.atsScore,
    source: input.source,
  })
}

/**
 * Patch metadata on an existing version. Deliberately cannot touch `content` —
 * a content change is a new version (see createResumeVersion).
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
 * are expected and insertVersionRow() still counts up from the surviving max.
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
