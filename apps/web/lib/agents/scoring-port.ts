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
import { ownedJobsQuery } from '@/lib/jobs/owned-query'
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

/** One row of person_jobs: the role, the person's own company for it, and their verdict on it. */
interface RoleRow extends FitRow {
  id: string
  title: string | null
  location: string | null
  posted_at: string | null
  url: string | null
  is_new: boolean | null
  still_open: boolean | null
  salary_range?: string | null
  viewer_company_id: string | null
  viewer_company_name: string | null
}

const ROLE_SELECT = `id, title, location, posted_at, url, is_new, still_open, viewer_company_id, viewer_company_name, ${FIT_COLUMNS}`
const POOL_MAX = 300

function sentence(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

export function toPick(row: RoleRow, exploration = false): RolePick | null {
  if (!row.id) return null
  const fit = parseFit(row)
  const chance = fit.chance && fit.chance.label !== 'cannot_assess' ? fit.chance.label : null
  const reason = chance === null ? NOT_ASSESSED : sentence(fit.want?.reason ?? fitHighlights(row.chance_detail, 1)[0] ?? '') || NOT_ASSESSED
  return {
    jobId: row.id,
    title: row.title,
    company: row.viewer_company_name,
    companyId: row.viewer_company_id,
    location: row.location,
    postedAt: row.posted_at,
    url: row.url,
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
  return (b.posted_at ?? '').localeCompare(a.posted_at ?? '')
}

async function loadPool(input: ShortlistInput): Promise<RoleRow[]> {
  // The person's own role rows: their company and their verdict are on them. The viewer fence is the ownership.
  let query = ownedJobsQuery(input.admin, input.userId, ROLE_SELECT).is('hidden_reason', null).eq('is_new', true)
  if (input.dreamOnly) {
    const { data: dream } = await input.admin.from('companies').select('id').eq('user_id', input.userId).eq('is_dream_company', true)
    const ids = ((dream as { id: string }[] | null) ?? []).map((c) => c.id)
    if (ids.length === 0) return []
    // ponytail: the first 200 dream companies; a person with more would need chunkedIn.
    query = query.in('viewer_company_id', ids.slice(0, 200))
  }
  const { data } = await query.order('want_p', { ascending: false, nullsFirst: false }).limit(POOL_MAX)
  // ponytail: open roles are filtered here after the cut of 300, not in the query. Move it into the query if a pool ever runs short of open roles.
  let rows = ((data as unknown as RoleRow[] | null) ?? []).filter((r) => r.still_open !== false && !isStalePosting(r.posted_at))
  if (input.location) {
    const want = input.location.toLowerCase()
    rows = rows.filter((r) => (r.location ?? '').toLowerCase().includes(want))
  }
  if (input.remoteOnly) rows = rows.filter((r) => /remote/i.test(r.location ?? ''))
  if (input.query && hasRelevanceTerms(parseRelevanceQuery(input.query))) {
    const flat = rows.map((r) => ({ row: r, title: r.title }))
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
        jobIds: missing.map((r) => r.id),
        limit: missing.length,
      })
      assessedNow = result.assessed
      skippedReason = result.skippedReason
      if (result.fits.size > 0) pool = pool.map((r) => (result.fits.has(r.id) ? { ...r, ...fitToColumns(result.fits.get(r.id)!) } : r))
    }
  }

  const sorted = [...pool].sort(byRank)
  const limit = Math.max(1, input.limit)
  const top = sorted.slice(0, limit)
  const picks = top.flatMap((r) => toPick(r) ?? [])

  // One labelled exploration slot: the best role below the cut at a company not already shown.
  if (sorted.length > limit && limit >= 4) {
    const shown = new Set(top.map((r) => r.viewer_company_id))
    const explore = sorted.slice(limit).find((r) => chanceOf(r) !== null && !shown.has(r.viewer_company_id))
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
  const { data } = await ownedJobsQuery(admin, userId, `${ROLE_SELECT}, salary_range`).eq('id', jobId).maybeSingle()
  const row = data as unknown as RoleRow | null
  const pick = row ? toPick(row) : null
  if (!row || !pick) return null
  const fit = parseFit(row)
  return {
    ...pick,
    salary: row.salary_range ?? null,
    requirements: {
      covered: fitHighlights(row.chance_detail, 10).map((s) => sentence(s, 140)),
      missing: (fit.chance?.gaps ?? []).slice(0, 6).map((s) => sentence(s, 140)),
    },
    assessed: row.assessed_at != null,
  }
}
