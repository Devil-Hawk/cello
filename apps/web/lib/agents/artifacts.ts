// Artifacts: the things the person keeps, the one store of made things (K17). A resume,
// a cover letter, drafted answers, a message, research, a comparison, a kept answer and a
// shortlist are rows with numbered versions ("You edited" and "Cello revised" are the
// author of a version). The type set and its two renames live in lib/artifacts/types.ts:
// rows stored under an old name read as the new one.
//
// Every write goes through here, with the service client, scoped by user id in
// code (the client bypasses RLS). A version is added by one database function so
// two edits at once never take the same number, and a retried tool call with the
// same key adds nothing the second time.

import { z } from 'zod'
import type { AdminClient } from '@/lib/harness/types'
import { ARTIFACT_TYPES, readType, storedNames, type ArtifactAbout, type ArtifactType } from '@/lib/artifacts/types'

export { ARTIFACT_TYPES }
export type { ArtifactType }

export type ArtifactAuthor = 'user' | 'cello'

// --- content shapes -----------------------------------------------------------------

const text = z.string().max(60_000)

export const ShortlistItemSchema = z.object({
  job_id: z.string(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  /** One sentence in the person's terms. */
  reason: z.string().max(400),
  chance: z.enum(['strong', 'possible', 'stretch']).nullable(),
  gaps: z.array(z.string().max(200)).max(6).default([]),
  /** Items shown to learn from, not because they rank highest. */
  exploration: z.boolean().default(false),
})
export type ShortlistItem = z.infer<typeof ShortlistItemSchema>

export const ArtifactContentSchemas = {
  // passthrough: a resume version also carries its structured form (content_json), title and source.
  resume: z
    .object({
      text,
      ats_score: z.number().nullable().optional(),
      matched_keywords: z.array(z.string()).max(60).optional(),
      missing_keywords: z.array(z.string()).max(60).optional(),
      format_issues: z.array(z.string()).max(30).optional(),
    })
    .passthrough(),
  cover_letter: z.object({
    text,
    keywords: z.array(z.string()).max(40).optional(),
    resume_summary: z.string().max(2000).optional(),
  }),
  /** Drafted answers for an application form. */
  answers: z.object({ answers: z.unknown() }),
  message: z.object({
    subject: z.string().max(300),
    body: text,
    to_name: z.string().nullable().optional(),
    to_email: z.string().nullable().optional(),
    outreach_id: z.string().nullable().optional(),
    /** A first note, a single follow-up to one already sent, a reply to a message received, or a note. */
    kind: z.enum(['initial', 'follow_up', 'reply', 'note']).optional(),
  }),
  research: z.object({
    company: z.string(),
    summary: z.string().max(20_000).nullable(),
    sponsors_visa: z.string().nullable().optional(),
    sources: z.array(z.object({ title: z.string().nullable().optional(), url: z.string() })).max(40).default([]),
    dossier_id: z.string().nullable().optional(),
    partial: z.boolean().optional(),
  }),
  comparison: z.object({ text, role_ids: z.array(z.string()).max(60).optional() }),
  /** A kept answer to a question the person may be asked again. */
  answer: z.object({ question: z.string().max(500), text }),
  shortlist: z.object({
    items: z.array(ShortlistItemSchema).max(60),
    generated_at: z.string(),
    note: z.string().max(500).nullable().optional(),
  }),
} satisfies Record<ArtifactType, z.ZodTypeAny>

export type ArtifactContent<T extends ArtifactType> = z.infer<(typeof ArtifactContentSchemas)[T]>

export function parseContent<T extends ArtifactType>(type: T, content: unknown): ArtifactContent<T> {
  return ArtifactContentSchemas[type].parse(content) as ArtifactContent<T>
}

/** A type as stored (either name until the contract migration) as the type set's name. */
function typeOf(stored: string): ArtifactType {
  const type = readType(stored)
  if (!type) throw new Error(`Unknown artifact type ${stored}`)
  return type
}

// --- markdown -----------------------------------------------------------------------

const list = (items: string[] | undefined) => (items && items.length ? items.map((i) => `- ${i}`).join('\n') : '')

/** The readable form of a version: what the agent reads and what is exported. */
export function renderMarkdown(type: ArtifactType, content: unknown): string {
  switch (type) {
    case 'resume': {
      const c = ArtifactContentSchemas.resume.parse(content)
      const extra = [
        c.matched_keywords?.length ? `Matched keywords: ${c.matched_keywords.join(', ')}` : '',
        c.missing_keywords?.length ? `Missing keywords: ${c.missing_keywords.join(', ')}` : '',
        c.format_issues?.length ? `Format issues:\n${list(c.format_issues)}` : '',
      ].filter(Boolean)
      return [c.text, ...extra].join('\n\n')
    }
    case 'cover_letter':
      return ArtifactContentSchemas.cover_letter.parse(content).text
    case 'message': {
      const c = ArtifactContentSchemas.message.parse(content)
      const to = c.to_name ? `To: ${c.to_name}${c.to_email ? ` <${c.to_email}>` : ''}\n` : ''
      return `${to}Subject: ${c.subject}\n\n${c.body}`
    }
    case 'answers':
      return JSON.stringify(ArtifactContentSchemas.answers.parse(content).answers, null, 2)
    case 'comparison':
      return ArtifactContentSchemas.comparison.parse(content).text
    case 'answer': {
      const c = ArtifactContentSchemas.answer.parse(content)
      return `${c.question}\n\n${c.text}`
    }
    case 'research': {
      const c = ArtifactContentSchemas.research.parse(content)
      const sources = c.sources.length ? `\n\nSources:\n${list(c.sources.map((s) => `${s.title ?? s.url} (${s.url})`))}` : ''
      return `# ${c.company}\n\n${c.summary ?? 'No summary yet. Public signals were collected.'}${sources}`
    }
    case 'shortlist': {
      const c = ArtifactContentSchemas.shortlist.parse(content)
      const rows = c.items.map(
        (i) => `- ${i.title ?? 'Role'} at ${i.company ?? 'a company'} [${i.chance ?? 'unrated'}${i.exploration ? ', to learn from' : ''}]: ${i.reason} (id ${i.job_id})`
      )
      return `# Shortlist\n\n${rows.join('\n')}${c.note ? `\n\n${c.note}` : ''}`
    }
  }
}

// --- paths (the agent's view of artifacts) ------------------------------------------

export const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled'

/** /artifacts/<type>/<slug>-<id>.md */
export function artifactPath(row: { id: string; type: string; title: string }): string {
  return `/artifacts/${row.type}/${slug(row.title)}-${row.id}.md`
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The artifact id in a path like /artifacts/cover_letter/note-<uuid>.md, or null. */
export function artifactIdFromPath(path: string): string | null {
  if (!path.startsWith('/artifacts/')) return null
  return path.match(UUID)?.[0]?.toLowerCase() ?? null
}

// --- rows ---------------------------------------------------------------------------

export interface ArtifactRow {
  id: string
  user_id: string
  /** Always the type set's name: a row stored under an old name is read as the new one. */
  type: ArtifactType
  title: string
  job_id: string | null
  company_id: string | null
  contact_id: string | null
  conversation_id: string | null
  /** Every object it is about; job_id, company_id and contact_id are indexed copies of the first of each. */
  about: ArtifactAbout[]
  application_id: string | null
  /** The person's base resume. At most one per person. */
  is_base: boolean
  current_version: number
  created_at: string
  updated_at: string
}

export interface ArtifactVersionRow {
  artifact_id: string
  version: number
  author: ArtifactAuthor
  content: unknown
  content_text: string
  note: string | null
  review: unknown
  trace_id: string | null
  created_at: string
}

const ARTIFACT_COLUMNS = 'id, user_id, type, title, job_id, company_id, contact_id, conversation_id, about, application_id, is_base, current_version, created_at, updated_at'

/** A stored row as the code reads it: the type under its current name. */
function normalizeRow(row: ArtifactRow): ArtifactRow {
  return { ...row, type: readType(row.type) ?? row.type }
}

export interface CreateArtifactInput {
  userId: string
  type: ArtifactType
  title: string
  content: unknown
  author: ArtifactAuthor
  jobId?: string | null
  companyId?: string | null
  contactId?: string | null
  conversationId?: string | null
  applicationId?: string | null
  about?: ArtifactAbout[]
  isBase?: boolean
  /** A retried call with the same key returns the first artifact. */
  idempotencyKey?: string
  review?: unknown
  note?: string | null
  traceId?: string | null
}

export interface ArtifactRef {
  id: string
  version: number
  /** False when an earlier call with the same key had already made it. */
  created: boolean
}

/** Create an artifact with its first version. Idempotent by key. */
export async function createArtifact(admin: AdminClient, input: CreateArtifactInput): Promise<ArtifactRef> {
  const content = parseContent(input.type, input.content)
  const contentText = renderMarkdown(input.type, content)

  if (input.idempotencyKey) {
    const existing = await findArtifactByKey(admin, input.userId, input.idempotencyKey)
    if (existing) return { id: existing.id, version: existing.current_version, created: false }
  }

  const { data, error } = await admin
    .from('artifacts')
    .insert({
      user_id: input.userId,
      type: input.type,
      title: input.title.slice(0, 200),
      job_id: input.jobId ?? null,
      company_id: input.companyId ?? null,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      application_id: input.applicationId ?? null,
      about: input.about ?? [],
      is_base: input.isBase ?? false,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('id')
    .single()

  if (error || !data) {
    // Two calls with one key at once: the loser reads the winner's row.
    if (input.idempotencyKey && (error as { code?: string } | null)?.code === '23505') {
      const existing = await findArtifactByKey(admin, input.userId, input.idempotencyKey)
      if (existing) return { id: existing.id, version: existing.current_version, created: false }
    }
    throw new Error(`Could not save the ${input.type.replace('_', ' ')}: ${error?.message ?? 'no row returned'}`)
  }

  const id = (data as { id: string }).id
  const { error: versionError } = await admin.from('artifact_versions').insert({
    artifact_id: id,
    version: 1,
    author: input.author,
    content,
    content_text: contentText,
    note: input.note ?? null,
    review: input.review ?? null,
    trace_id: input.traceId ?? null,
  })
  if (versionError) {
    await admin.from('artifacts').delete().eq('id', id)
    throw new Error(`Could not save the ${input.type.replace('_', ' ')}: ${versionError.message}`)
  }
  return { id, version: 1, created: true }
}

/** The artifact an earlier call with this key made, if any. */
export async function findArtifactByKey(admin: AdminClient, userId: string, key: string): Promise<ArtifactRow | null> {
  const { data } = await admin.from('artifacts').select(ARTIFACT_COLUMNS).eq('user_id', userId).eq('idempotency_key', key).maybeSingle()
  return data ? normalizeRow(data as ArtifactRow) : null
}

export interface AddVersionInput {
  userId: string
  artifactId: string
  author: ArtifactAuthor
  content: unknown
  note?: string | null
  review?: unknown
  traceId?: string | null
  idempotencyKey?: string
}

/** Add the next version of an artifact. Returns its number. Throws when the artifact is not this user's. */
export async function addVersion(admin: AdminClient, input: AddVersionInput): Promise<number> {
  const artifact = await getArtifactRow(admin, input.userId, input.artifactId)
  if (!artifact) throw new Error(`No artifact with id ${input.artifactId}`)
  const content = parseContent(typeOf(artifact.type), input.content)
  const { data, error } = await admin.rpc('artifact_add_version', {
    p_user_id: input.userId,
    p_artifact_id: input.artifactId,
    p_author: input.author,
    p_content: content,
    p_content_text: renderMarkdown(typeOf(artifact.type), content),
    p_note: input.note ?? null,
    p_review: input.review ?? null,
    p_trace_id: input.traceId ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  })
  if (error) throw new Error(`Could not save the new version: ${error.message}`)
  return data as number
}

export async function getArtifactRow(admin: AdminClient, userId: string, id: string): Promise<ArtifactRow | null> {
  const { data } = await admin.from('artifacts').select(ARTIFACT_COLUMNS).eq('id', id).eq('user_id', userId).maybeSingle()
  return data ? normalizeRow(data as ArtifactRow) : null
}

export interface ArtifactWithVersion {
  artifact: ArtifactRow
  version: ArtifactVersionRow
}

/** One artifact with one version (the current one unless asked). Null when it is not this user's. */
export async function getArtifact(
  admin: AdminClient,
  userId: string,
  id: string,
  opts: { version?: number } = {}
): Promise<ArtifactWithVersion | null> {
  const artifact = await getArtifactRow(admin, userId, id)
  if (!artifact) return null
  const { data } = await admin
    .from('artifact_versions')
    .select('artifact_id, version, author, content, content_text, note, review, trace_id, created_at')
    .eq('artifact_id', id)
    .eq('version', opts.version ?? artifact.current_version)
    .maybeSingle()
  if (!data) return null
  return { artifact, version: data as ArtifactVersionRow }
}

export async function listVersions(admin: AdminClient, userId: string, id: string): Promise<ArtifactVersionRow[]> {
  if (!(await getArtifactRow(admin, userId, id))) return []
  const { data } = await admin
    .from('artifact_versions')
    .select('artifact_id, version, author, content, content_text, note, review, trace_id, created_at')
    .eq('artifact_id', id)
    .order('version', { ascending: false })
  return (data as ArtifactVersionRow[] | null) ?? []
}

export interface ListArtifactsInput {
  type?: ArtifactType
  jobId?: string
  limit?: number
  offset?: number
}

export async function listArtifacts(admin: AdminClient, userId: string, opts: ListArtifactsInput = {}): Promise<ArtifactRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  let q = admin.from('artifacts').select(ARTIFACT_COLUMNS).eq('user_id', userId)
  if (opts.type) q = q.in('type', [...storedNames(opts.type)])
  if (opts.jobId) q = q.eq('job_id', opts.jobId)
  const { data } = await q.order('updated_at', { ascending: false }).range(opts.offset ?? 0, (opts.offset ?? 0) + limit - 1)
  return ((data as ArtifactRow[] | null) ?? []).map(normalizeRow)
}

/** Normalised edit distance between two texts, 0 (same) to 1 (nothing shared). Used for the "edited" feedback score. */
export function editDistanceRatio(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.max(a.length, b.length)
  if (n === 0) return 0
  // Cap the work: a very long text is compared on its first 4000 characters.
  const x = a.slice(0, 4000)
  const y = b.slice(0, 4000)
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return Math.min(1, prev[y.length] / Math.max(x.length, y.length))
}
