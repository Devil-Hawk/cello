// What the shortlist needs to know about one person, read from the database: the
// resume, what they stated (preferences, constraints, what Cello remembers), and
// the open roles that could be assessed.

import { callEmbedding, EMBEDDING_MODEL, isEmbeddingFallback } from '@/lib/harness/llm'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'
import { QUALITY_REJECT_THRESHOLD } from '@/lib/jobs/classify'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { ownedJobsQuery } from '@/lib/jobs/owned-query'
import { prioritiseByTargetTitles } from '@/lib/jobs/target-relevance'
import { getMemoryStore } from '@/lib/memory/mem0-store'
import { resolveTargeting, type Targeting } from '@/lib/targeting'
import { resolveTargetTitles } from '@/lib/targeting/titles'
import { resolveConstraints, type StatedConstraints } from './constraints'
import type { Embedder } from './pipeline'
import type { RoleFacts } from './types'
import type { StatedPreferences } from './want-judge'

export interface ScoringInputs {
  resumeText: string
  stated: StatedPreferences
  constraints: StatedConstraints
  /** The person's targeting settings: what narrows the roles worth assessing. */
  targeting: Targeting
  nReactions: number
}

const MEMORY_QUERY = 'what roles, companies, places and pay they want or refuse'
const MEMORY_NOTES = 6
const MEMORY_TIMEOUT_MS = 3000

/** One or two lines of what the resume says about the person, for the judge. */
export function resumeBackground(resume: string): string {
  const lines = resume.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const at = lines.findIndex((l) => /^(professional\s+)?(summary|profile|about)\b/i.test(l))
  const body = at >= 0 ? lines.slice(at + 1) : lines.slice(1)
  return body
    .filter((l) => l.length > 20)
    .slice(0, 2)
    .join(' ')
    .slice(0, 600)
}

async function memoryNotes(userId: string): Promise<string[]> {
  try {
    const found = await Promise.race([
      getMemoryStore().search(userId, MEMORY_QUERY, { limit: MEMORY_NOTES }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('memory search timed out')), MEMORY_TIMEOUT_MS)),
    ])
    return found.map((m) => m.memory.trim()).filter(Boolean).slice(0, MEMORY_NOTES)
  } catch {
    // What Cello remembers is a bonus. Without it the stated preferences still stand.
    return []
  }
}

export async function loadScoringInputs(admin: AdminClient, userId: string): Promise<ScoringInputs> {
  const [{ data: profile }, { data: dream }, { count }, notes] = await Promise.all([
    admin.from('profiles').select('resume_text, preferences').eq('id', userId).maybeSingle(),
    admin.from('companies').select('name').eq('user_id', userId).eq('is_dream_company', true).limit(10),
    admin.from('role_reactions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    memoryNotes(userId),
  ])
  const prefs = (profile as { preferences?: unknown } | null)?.preferences ?? {}
  const resumeText = ((profile as { resume_text?: string | null } | null)?.resume_text ?? '').trim()
  const t = resolveTargeting(prefs)
  return {
    resumeText,
    constraints: resolveConstraints(prefs),
    targeting: t,
    nReactions: count ?? 0,
    stated: {
      titles: resolveTargetTitles(prefs),
      functions: t.functions,
      seniority: t.seniority,
      countries: t.countries,
      remoteOnly: t.remoteOnly,
      likedCompanies: ((dream as { name: string }[] | null) ?? []).map((c) => c.name),
      dislikedCompanies: t.excludedCompanies,
      notes,
      background: resumeBackground(resumeText),
    },
  }
}

// ---------------------------------------------------------------------------
// Candidate roles
// ---------------------------------------------------------------------------

// The roles come from the person's own rows (public.person_roles) with the posting
// embedded: a role the person has no row for is not theirs to assess, and the
// verdict columns are on the row, so "not assessed yet" is `assessed_at is null`.
// The posting's own columns are filtered through the embed (`referencedTable`).

interface CandidateRow {
  id: string
  title: string
  description: string | null
  location: string | null
  salary_range: string | null
  seniority: string | null
  country: string | null
  is_remote: boolean | null
  job_function: string | null
  /** The person's own company for the role (person_jobs), never the one that stored it first. */
  viewer_company_name: string | null
}

const JOB_COLUMNS = 'id, title, description, location, salary_range, seniority, country, is_remote, job_function, viewer_company_name'

function quote(v: string): string {
  return /[,()"]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v
}

/** A facet matches a wanted value, or is not classified yet. The same rule the jobs list uses. */
function facet(column: string, values: string[]): string {
  return column + '.is.null,' + column + '.eq.unknown,' + column + '.in.(' + values.map(quote).join(',') + ')'
}

export function toRoleFacts(row: CandidateRow): RoleFacts {
  return {
    id: row.id,
    title: row.title,
    company: row.viewer_company_name ?? '',
    location: row.location,
    description: row.description,
    salaryRange: row.salary_range,
    seniority: row.seniority,
    country: row.country,
    isRemote: row.is_remote,
    jobFunction: row.job_function,
  }
}

function factsOf(rows: CandidateRow[] | null): RoleFacts[] {
  return (rows ?? []).map(toRoleFacts)
}

export interface CandidateOptions {
  limit: number
  /** Only roles that have never been assessed. */
  onlyUnassessed?: boolean
  /** Assess exactly these roles (any state), instead of picking the newest. */
  jobIds?: string[]
  /** Open roles the person already reacted to are left out unless asked for. */
  includeReacted?: boolean
}

/**
 * The open roles worth assessing, newest first. Junk postings are skipped and the
 * function and level the person asked for narrow the recall, but nothing they
 * ruled out (country, company, words in a title) is dropped here: those roles are
 * assessed so each one carries the reason it was filtered. A role the person hid
 * is not assessed again.
 */
export async function candidateRoles(admin: AdminClient, userId: string, targeting: Targeting, titles: readonly string[], opts: CandidateOptions): Promise<RoleFacts[]> {
  if (opts.jobIds && opts.jobIds.length > 0) {
    const { data, error } = await ownedJobsQuery(admin, userId, JOB_COLUMNS).in('id', opts.jobIds.slice(0, 200))
    if (error) throw new Error('could not read roles: ' + error.message)
    return factsOf(data as unknown as CandidateRow[] | null)
  }
  const pool = Math.min(400, Math.max(opts.limit * 4, 80))
  let query = openRolesOnly(ownedJobsQuery(admin, userId, JOB_COLUMNS).is('hidden_reason', null)).or(
    'quality_score.is.null,quality_score.gte.' + QUALITY_REJECT_THRESHOLD
  )
  if (opts.onlyUnassessed) query = query.is('assessed_at', null)
  if (targeting.functions.length > 0) query = query.or(facet('job_function', targeting.functions))
  if (targeting.seniority.length > 0) query = query.or(facet('seniority', targeting.seniority))
  if (targeting.languages.length > 0) query = query.or(facet('language', targeting.languages))
  const { data, error } = await query.order('posted_at', { ascending: false, nullsFirst: false }).limit(pool)
  if (error) throw new Error('could not read roles: ' + error.message)
  let rows = factsOf(data as unknown as CandidateRow[] | null)

  if (!opts.includeReacted && rows.length > 0) {
    const reacted = new Set<string>()
    const r = await admin.from('role_reactions').select('job_id').eq('user_id', userId).not('job_id', 'is', null).limit(5000)
    for (const x of (r.data as { job_id: string }[] | null) ?? []) reacted.add(x.job_id)
    rows = rows.filter((x) => !reacted.has(x.id))
  }
  return prioritiseByTargetTitles(rows, titles).slice(0, opts.limit)
}

/**
 * How many of the person's roles still wait for an assessment: the ones the
 * candidate query would pick up (`inRecall`), and all of them (`total`). The
 * difference is roles outside the function or level they asked for, which stay
 * unassessed on purpose.
 */
export async function countUnassessed(admin: AdminClient, userId: string, targeting: Targeting): Promise<{ inRecall: number; total: number }> {
  const head = { count: 'exact' as const, head: true }
  const base = () => ownedJobsQuery(admin, userId, 'id', head).is('hidden_reason', null).is('assessed_at', null)
  const total = await base()
  let q = openRolesOnly(base()).or('quality_score.is.null,quality_score.gte.' + QUALITY_REJECT_THRESHOLD)
  if (targeting.functions.length > 0) q = q.or(facet('job_function', targeting.functions))
  if (targeting.seniority.length > 0) q = q.or(facet('seniority', targeting.seniority))
  if (targeting.languages.length > 0) q = q.or(facet('language', targeting.languages))
  const inRecall = await q
  return { inRecall: inRecall.count ?? 0, total: total.count ?? 0 }
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * The embedding path the app already uses (callEmbedding, metered by the spend
 * chokepoint). No provider, or a month's cap reached, is not an error: the
 * similarity signal is skipped and the rest still works. Vectors from another
 * model than the one named here are refused, because they are never compared.
 */
export function makeEmbedder(apiKeys: DecryptedApiKeys): Embedder {
  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      try {
        const r = await callEmbedding(apiKeys, { texts, name: 'embed-roles' })
        return r.model === EMBEDDING_MODEL ? r.embeddings : null
      } catch (err) {
        if (isEmbeddingFallback(err)) return null
        throw err
      }
    },
  }
}
