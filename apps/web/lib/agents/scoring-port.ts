// The scoring seam: the only file the Scout and the triage tool use to rank roles
// and to record what the person thought of one.
//
// It reads what lib/scoring stored on the person's own row for each role (their want
// and their chance), assesses unassessed roles through assessJobs, and records a
// reaction through triageRole. The daily picks (runDailyShortlist) are switched off
// until they beat plain ordering, so the list here is ordered by chance and want.
//
// Rules this file keeps:
//   - a role that was not assessed says so (chance null, "Not assessed yet"), never a guess
//   - the reason is stored text in the person's terms, never invented here
//   - one slot in a full shortlist is labelled exploration: a role ranked below the cut,
//     shown so Cello can learn from the reaction, not because it ranks highest

import { makeRunner } from '@/lib/harness/copilot-tools'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { isStalePosting } from '@/lib/jobs/freshness'
import { hasRelevanceTerms, parseRelevanceQuery, rankJobsByRelevance } from '@/lib/jobs/relevance'
import { assessJobs, FIT_COLUMNS, parseFit, PASS_REASONS, ScoringInputError, triageRole, type PassReason } from '@/lib/scoring'
import { fitHighlights, fitToColumns, type FitRow } from '@/lib/scoring/read'
import type { AdminClient, DecryptedApiKeys } from '@/lib/harness/types'

export type Chance = 'strong' | 'possible' | 'stretch'
export type Reaction = 'interested' | 'not_for_me' | 'applied'

export const NOT_ASSESSED = 'Not assessed yet.'

export interface RolePick {
  jobId: string
  title: string | null
  company: string | null
  companyId: string | null
  location: string | null
  postedAt: string | null
  url: string | null
  /** Null until the role has been assessed. */
  chance: Chance | null
  /** One sentence in the person's terms, or "Not assessed yet." */
  reason: string
  gaps: string[]
  exploration: boolean
}

export interface ShortlistInput {
  admin: AdminClient
  userId: string
  apiKeys: DecryptedApiKeys
  limit: number
  query?: string
  /** Assess up to this many unassessed roles first (costs model calls). 0 reads what is stored. */
  assessMissing?: number
  location?: string
  remoteOnly?: boolean
  dreamOnly?: boolean
  signal?: AbortSignal
}

export interface ShortlistOutput {
  picks: RolePick[]
  /** Roles in the pool before the cut. */
  pool: number
  assessedNow: number
  skippedReason?: string
}

interface Posting {
  id: string
  title: string | null
  company_id: string | null
  location: string | null
  posted_at: string | null
  url: string | null
  is_new: boolean | null
  still_open: boolean | null
  salary_range?: string | null
  companies?: Company | Company[] | null
  /** The employer's directory row: names a role the person holds under no company of their own. */
  employer?: { name?: string | null } | { name?: string | null }[] | null
}

type Company = { name?: string | null; user_id?: string | null; is_dream_company?: boolean | null }

/** A person_roles row: their verdict, with the posting embedded. */
interface RoleRow extends FitRow {
  job_id: string
  jobs: Posting | Posting[] | null
}

const POSTING = 'id, title, company_id, location, posted_at, url, is_new, still_open, companies(name, user_id, is_dream_company), employer:company_directory(name)'
const POOL_MAX = 300

const first = <T>(rel: T | T[] | null | undefined): T | null => (Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null))

function sentence(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export function toPick(row: RoleRow, exploration = false): RolePick | null {
  const job = first(row.jobs)
  if (!job) return null
  const fit = parseFit({ id: job.id, ...row })
  const chance = fit.chance && fit.chance.label !== 'cannot_assess' ? fit.chance.label : null
  const reason = chance === null ? NOT_ASSESSED : sentence(fit.want?.reason ?? fitHighlights(row.chance_detail, 1)[0] ?? '') || NOT_ASSESSED
  return {
    jobId: job.id,
    title: job.title,
    company: first(job.companies)?.name ?? first(job.employer)?.name ?? null,
    companyId: first(job.companies) ? job.company_id : null,
    location: job.location,
    postedAt: job.posted_at,
    url: job.url,
    chance,
    reason,
    gaps: (fit.chance?.gaps ?? []).slice(0, 4).map((g) => sentence(g, 120)),
    exploration,
  }
}

const RANK: Record<Chance | 'none', number> = { strong: 3, possible: 2, stretch: 1, none: 0 }

const chanceOf = (r: RoleRow): Chance | null => (r.chance === 'strong' || r.chance === 'possible' || r.chance === 'stretch' ? r.chance : null)

/** Best first: assessed before not, by chance, then by what the person wants, then newest. */
function byRank(a: RoleRow, b: RoleRow): number {
  const ra = RANK[chanceOf(a) ?? 'none']
  const rb = RANK[chanceOf(b) ?? 'none']
  if (ra !== rb) return rb - ra
  if ((b.want_p ?? -1) !== (a.want_p ?? -1)) return (b.want_p ?? -1) - (a.want_p ?? -1)
  return (first(b.jobs)?.posted_at ?? '').localeCompare(first(a.jobs)?.posted_at ?? '')
}

/** A role is one shared row, so its company may be another follower's: only the person's own company stays on it. */
function ownCompanyOnly(rows: RoleRow[], userId: string): RoleRow[] {
  return rows.map((r) => {
    const job = first(r.jobs)
    if (!job) return r
    const company = first(job.companies)
    return company && company.user_id === userId ? r : { ...r, jobs: { ...job, companies: null } }
  })
}

async function loadPool(input: ShortlistInput): Promise<RoleRow[]> {
  const query = input.admin
    .from('person_roles')
    .select(`job_id, ${FIT_COLUMNS}, jobs!inner(${POSTING})`)
    .eq('user_id', input.userId)
    .is('hidden_reason', null)
    .eq('jobs.is_new', true)
  const { data } = await query.order('want_p', { ascending: false, nullsFirst: false }).limit(POOL_MAX)
  // ponytail: open roles are filtered here after the cut of 300, not in the query. Move it into the query if a pool ever runs short of open roles.
  let rows = ownCompanyOnly((data as unknown as RoleRow[] | null) ?? [], input.userId).filter((r) => {
    const job = first(r.jobs)
    return job !== null && job.still_open !== false && !isStalePosting(job.posted_at)
  })
  // ponytail: dream companies are narrowed here, after the cut of 300 (they are the person's own, so only a role under one qualifies).
  if (input.dreamOnly) rows = rows.filter((r) => first(first(r.jobs)?.companies)?.is_dream_company === true)
  if (input.location) {
    const want = input.location.toLowerCase()
    rows = rows.filter((r) => (first(r.jobs)?.location ?? '').toLowerCase().includes(want))
  }
  if (input.remoteOnly) rows = rows.filter((r) => /remote/i.test(first(r.jobs)?.location ?? ''))
  if (input.query && hasRelevanceTerms(parseRelevanceQuery(input.query))) {
    const flat = rows.map((r) => ({ row: r, title: first(r.jobs)?.title ?? null }))
    rows = rankJobsByRelevance(flat, input.query)
      .filter((r) => r.relevance.score > 0)
      .map((r) => r.job.row)
  }
  return rows
}

export async function shortlistFor(input: ShortlistInput): Promise<ShortlistOutput> {
  let pool = await loadPool(input)
  let assessedNow = 0
  let skippedReason: string | undefined

  const missing = pool.filter((r) => r.assessed_at == null).slice(0, Math.max(0, input.assessMissing ?? 0))
  if (missing.length > 0) {
    if (!canRunLlm(input.apiKeys)) {
      skippedReason = 'no-llm-key'
    } else {
      const result = await assessJobs({
        admin: input.admin,
        userId: input.userId,
        apiKeys: input.apiKeys,
        llm: makeRunner({ admin: input.admin, userId: input.userId, userEmail: '', apiKeys: input.apiKeys, signal: input.signal }, input.signal, 'assess-roles'),
        jobIds: missing.map((r) => r.job_id),
        limit: missing.length,
      })
      assessedNow = result.assessed
      skippedReason = result.skippedReason
      if (result.fits.size > 0) pool = pool.map((r) => (result.fits.has(r.job_id) ? { ...r, ...fitToColumns(result.fits.get(r.job_id)!) } : r))
    }
  }

  const sorted = [...pool].sort(byRank)
  const limit = Math.max(1, input.limit)
  const top = sorted.slice(0, limit)
  const picks = top.flatMap((r) => toPick(r) ?? [])

  // One labelled exploration slot: the best role below the cut at a company not already shown.
  if (sorted.length > limit && limit >= 4) {
    const shown = new Set(top.map((r) => first(r.jobs)?.company_id))
    const explore = sorted.slice(limit).find((r) => chanceOf(r) !== null && !shown.has(first(r.jobs)?.company_id))
    const pick = explore ? toPick(explore, true) : null
    if (pick) picks[picks.length - 1] = pick
  }
  return { picks, pool: sorted.length, assessedNow, skippedReason }
}

// --- reactions ---------------------------------------------------------------------

export interface ReactionInput {
  admin: AdminClient
  userId: string
  jobId: string
  reaction: Reaction
  reason?: string
}

export interface ReactionOutcome {
  jobId: string
  reaction: Reaction
  /** What changed, in plain words. */
  what: string
}

export type ReactionResult = { ok: true; outcome: ReactionOutcome } | { ok: false; error: string; fix: string }

/** Record Interested, Not for me or Applied for one role the person owns. A reason Cello knows is kept as the reason; any other text is kept as a note. */
export async function recordReaction(input: ReactionInput): Promise<ReactionResult> {
  const { admin, userId, jobId, reaction } = input
  const text = input.reason?.trim().slice(0, 300) || null
  const known = reaction === 'not_for_me' && text && (PASS_REASONS as readonly string[]).includes(text)
  try {
    const done = await triageRole({
      db: admin,
      userId,
      jobId,
      reaction,
      reason: known ? (text as PassReason) : null,
      note: known ? null : text,
      surface: 'chat',
    })
    return { ok: true, outcome: { jobId, reaction, what: done.message } }
  } catch (err) {
    if (err instanceof ScoringInputError) return { ok: false, error: `No role with id ${jobId}.`, fix: 'Call find_roles and use an id it returned.' }
    throw err
  }
}

/** The role as the person sees it: stored facts and assessment, no raw posting text. */
export interface RoleView extends RolePick {
  salary: string | null
  /** From the stored assessment: what the role asks for that the resume covers, and what it does not. */
  requirements: { covered: string[]; missing: string[] }
  assessed: boolean
}

export async function roleView(admin: AdminClient, userId: string, jobId: string): Promise<RoleView | null> {
  const { data } = await admin
    .from('person_roles')
    .select(`job_id, ${FIT_COLUMNS}, jobs!inner(${POSTING}, salary_range)`)
    .eq('user_id', userId)
    .eq('job_id', jobId)
    .maybeSingle()
  const row = data ? ownCompanyOnly([data as unknown as RoleRow], userId)[0] : null
  const pick = row ? toPick(row) : null
  if (!row || !pick) return null
  const fit = parseFit({ id: jobId, ...row })
  return {
    ...pick,
    salary: first(row.jobs)?.salary_range ?? null,
    requirements: {
      covered: fitHighlights(row.chance_detail, 10).map((s) => sentence(s, 140)),
      missing: (fit.chance?.gaps ?? []).slice(0, 6).map((s) => sentence(s, 140)),
    },
    assessed: row.assessed_at != null,
  }
}
