// The resume store, over `artifacts` and `artifact_versions` (K17, the one store of made things).
//
// A resume bucket is one artifact of type `resume`: the person's BASE resume (`is_base`, at most
// one per person) or the resume tailored for one job. Its versions are numbered, append-only
// snapshots, exactly as `resume_documents` rows were. The exports and the ResumeDocument shape
// are unchanged, so no caller moved: a version's id is its `artifact_versions.id`, which for
// versions copied from `resume_documents` is the id that row had, so every link and every
// applications.resume_version value still opens.
//
// WHICH CLIENT TO PASS
//   Reads work with the cookie-scoped client (RLS lets a person read their own artifacts). Writes
//   need the service-role admin client (lib/harness/supabase-admin.ts createAdminClient()):
//   artifact_add_version is not executable by signed-in roles. Because service-role BYPASSES RLS,
//   every function here filters on `user_id` explicitly. Never remove that predicate.
//
// APPEND-ONLY BY DESIGN
//   Content is never updated in place. createResumeVersion() appends a numbered snapshot so the
//   resume studio can diff and roll back. Only metadata (title, ats_score) is patchable.
//
// THE ONLY WRITER
//   createResumeVersion() takes a structured Resume, validates it, and derives every stored field
//   from it. The row insert is private, so nothing can store a version whose plain text, Markdown
//   and structure disagree. store.guard.test.ts enforces this, and that nothing writes
//   `resume_documents` any more: it is read-only history.
//
// THE MIRROR
//   A trigger on artifact_versions mirrors the newest BASE version's text into profiles.resume_text.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resumeToMarkdown, resumeToPlainText } from './render'
import { ResumeSchema, type Resume } from './schema'
import type { ResumeContentJson, ResumeDocument, ResumeSource, ResumeVersionPatch } from './types'

/** Postgres unique-violation SQLSTATE, raised when two writers race to create one bucket. */
const UNIQUE_VIOLATION = '23505'

/** Hard ceiling on listVersions(), so a bad `limit` can never scan the table. */
const MAX_LIST_LIMIT = 200

const ARTIFACT_COLUMNS = 'id, user_id, job_id, is_base, current_version, created_at, updated_at'
const VERSION_COLUMNS = 'id, artifact_id, version, author, content, content_text, created_at'

interface BucketRow {
  id: string
  user_id: string
  job_id: string | null
  is_base: boolean
  current_version: number
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  artifact_id: string
  version: number
  author: 'user' | 'cello'
  content: {
    content_json?: ResumeContentJson | null
    title?: string | null
    ats_score?: number | null
    source?: ResumeSource | null
    draft_id?: string | null
    updated_at?: string
  } | null
  content_text: string
  created_at: string
}

/** A version as the resume pages read it, with the artifact it belongs to. */
export type StoredResume = ResumeDocument & { artifact_id: string }

function toDocument(bucket: BucketRow, v: VersionRow): StoredResume {
  const c = v.content ?? {}
  return {
    id: v.id,
    artifact_id: v.artifact_id,
    user_id: bucket.user_id,
    job_id: bucket.job_id,
    draft_id: c.draft_id ?? null,
    version: v.version,
    title: c.title ?? null,
    content: v.content_text,
    content_json: c.content_json ?? null,
    ats_score: c.ats_score ?? null,
    source: c.source ?? (bucket.job_id ? 'tailored' : 'base'),
    created_at: v.created_at,
    updated_at: c.updated_at ?? v.created_at,
  }
}

/** The key a bucket's artifact carries. The copy in migration 20261017000000 uses the same one. */
const bucketKey = (userId: string, jobId: string | null) => `k17:resume_documents:${userId}:${jobId ?? 'base'}`

/** The artifact for a bucket, or null when it has none yet. Pass `jobId = null` for the base resume. */
async function findBucket(client: SupabaseClient, userId: string, jobId: string | null): Promise<BucketRow | null> {
  const base = client.from('artifacts').select(ARTIFACT_COLUMNS).eq('user_id', userId).eq('type', 'resume')
  const { data, error } = await (jobId ? base.eq('idempotency_key', bucketKey(userId, jobId)) : base.eq('is_base', true)).limit(1).maybeSingle()
  if (error) throw new Error(`resume bucket lookup failed: ${error.message}`)
  return (data as BucketRow | null) ?? null
}

/** The newest version in a bucket, or null when the bucket is empty. Pass `jobId = null` for the base resume. */
export async function getLatestVersion(client: SupabaseClient, userId: string, jobId: string | null): Promise<StoredResume | null> {
  const bucket = await findBucket(client, userId, jobId)
  if (!bucket) return null
  const { data, error } = await client.from('artifact_versions').select(VERSION_COLUMNS).eq('artifact_id', bucket.id).order('version', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`getLatestVersion failed: ${error.message}`)
  return data ? toDocument(bucket, data as VersionRow) : null
}

/** Every version in a bucket, newest first. Pass `jobId = null` for the base resume. `limit` is clamped to 1..200. */
export async function listVersions(client: SupabaseClient, userId: string, jobId: string | null, opts: { limit?: number } = {}): Promise<StoredResume[]> {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.limit ?? 50))
  const bucket = await findBucket(client, userId, jobId)
  if (!bucket) return []
  const { data, error } = await client.from('artifact_versions').select(VERSION_COLUMNS).eq('artifact_id', bucket.id).order('version', { ascending: false }).limit(limit)
  if (error) throw new Error(`listVersions failed: ${error.message}`)
  return ((data as VersionRow[] | null) ?? []).map((v) => toDocument(bucket, v))
}

/** The current base resume. Null when the person has never saved one (fall back to `profiles.resume_text`). */
export async function getBaseResume(client: SupabaseClient, userId: string): Promise<StoredResume | null> {
  return getLatestVersion(client, userId, null)
}

/** One version by id, scoped to its owner. */
export async function getVersionById(client: SupabaseClient, userId: string, id: string): Promise<StoredResume | null> {
  const { data, error } = await client.from('artifact_versions').select(VERSION_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`getVersionById failed: ${error.message}`)
  if (!data) return null
  const v = data as VersionRow
  // The version belongs to a resume artifact of this person, or it is not theirs to see.
  const { data: bucket } = await client.from('artifacts').select(ARTIFACT_COLUMNS).eq('id', v.artifact_id).eq('user_id', userId).eq('type', 'resume').maybeSingle()
  return bucket ? toDocument(bucket as BucketRow, v) : null
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

/** The bucket's artifact, created when it is not there. Two writers racing on the same bucket end up on one artifact. */
async function ensureBucket(client: SupabaseClient, userId: string, jobId: string | null): Promise<{ bucket: BucketRow; created: boolean }> {
  const found = await findBucket(client, userId, jobId)
  if (found) return { bucket: found, created: false }
  let title = 'Base resume'
  if (jobId) {
    const { data } = await client.from('jobs').select('title').eq('id', jobId).maybeSingle()
    title = `Resume for ${(data as { title?: string } | null)?.title ?? 'a role'}`.slice(0, 200)
  }
  // A new artifact starts at version 1 (its check says so); its first version is written below.
  const { data, error } = await client
    .from('artifacts')
    .insert({ user_id: userId, type: 'resume', title, job_id: jobId, is_base: jobId === null, idempotency_key: bucketKey(userId, jobId) })
    .select(ARTIFACT_COLUMNS)
    .single()
  if (!error) return { bucket: data as BucketRow, created: true }
  if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw new Error(`createResumeVersion failed: ${error.message}`)
  const raced = await findBucket(client, userId, jobId)
  if (!raced) throw new Error(`createResumeVersion failed: ${error.message}`)
  return { bucket: raced, created: false }
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
  /** The Reviewer's result for a draft, and the trace that wrote it. */
  review?: unknown
  traceId?: string | null
}

/** Append a version to a bucket. artifact_add_version assigns the next number atomically. */
async function insertVersionRow(client: SupabaseClient, input: InsertRow): Promise<StoredResume> {
  const content = input.content?.trim()
  if (!content) throw new Error('createResumeVersion failed: content is empty')
  if (!input.userId) throw new Error('createResumeVersion failed: userId is required')

  const jobId = input.jobId ?? null
  const source: ResumeSource = input.source ?? (jobId ? 'tailored' : 'base')
  const author = source === 'tailored' ? 'cello' : 'user'
  const stored = { text: content, content_json: input.contentJson, title: input.title ?? null, ats_score: input.atsScore ?? null, source, draft_id: input.draftId ?? null }
  const { bucket, created } = await ensureBucket(client, input.userId, jobId)

  let versionNumber = 1
  if (created) {
    const { error } = await client
      .from('artifact_versions')
      .insert({ artifact_id: bucket.id, version: 1, author, content: stored, content_text: content, review: input.review ?? null, trace_id: input.traceId ?? null })
    if (error) throw new Error(`createResumeVersion failed: ${error.message}`)
  } else {
    const { data, error } = await client.rpc('artifact_add_version', {
      p_user_id: input.userId,
      p_artifact_id: bucket.id,
      p_author: author,
      p_content: stored,
      p_content_text: content,
      p_note: null,
      p_review: input.review ?? null,
      p_trace_id: input.traceId ?? null,
      p_idempotency_key: null,
    })
    if (error) throw new Error(`createResumeVersion failed: ${error.message}`)
    versionNumber = data as number
  }
  const { data: row, error: readError } = await client.from('artifact_versions').select(VERSION_COLUMNS).eq('artifact_id', bucket.id).eq('version', versionNumber).single()
  if (readError || !row) throw new Error(`createResumeVersion failed: ${readError?.message ?? 'the new version was not found'}`)
  return toDocument(bucket, row as VersionRow)
}

/**
 * Append a version from a structured Resume. The Resume is validated (throws before any write)
 * and everything stored is derived from it, so there is no way to call this that produces a
 * divergent set of columns.
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
    review?: unknown
    traceId?: string | null
  }
): Promise<StoredResume> {
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
    review: input.review,
    traceId: input.traceId,
  })
}

/**
 * Patch metadata on an existing version. Deliberately cannot touch the text: a content change is
 * a new version (see createResumeVersion).
 */
export async function updateVersionMeta(client: SupabaseClient, userId: string, id: string, patch: ResumeVersionPatch): Promise<StoredResume> {
  if (patch.title === undefined && patch.atsScore === undefined) throw new Error('updateVersionMeta failed: nothing to update')
  const current = await getVersionById(client, userId, id)
  if (!current) throw new Error('updateVersionMeta failed: no such version')
  const { data: row } = await client.from('artifact_versions').select(VERSION_COLUMNS).eq('id', id).single()
  const v = row as VersionRow
  const content = {
    ...(v.content ?? {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.atsScore !== undefined ? { ats_score: patch.atsScore } : {}),
    updated_at: new Date().toISOString(),
  }
  const { error } = await client.from('artifact_versions').update({ content }).eq('id', id)
  if (error) throw new Error(`updateVersionMeta failed: ${error.message}`)
  return { ...current, title: content.title ?? null, ats_score: content.ats_score ?? null, updated_at: content.updated_at }
}

/**
 * Delete one version. Version numbers are NOT renumbered afterwards, so gaps are expected and the
 * next version still counts up from the artifact's own counter.
 */
export async function deleteVersion(client: SupabaseClient, userId: string, id: string): Promise<void> {
  const current = await getVersionById(client, userId, id)
  if (!current) return
  const { error } = await client.from('artifact_versions').delete().eq('id', id)
  if (error) throw new Error(`deleteVersion failed: ${error.message}`)
}
