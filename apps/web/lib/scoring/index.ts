// The public face of the shortlist. Everything that decides which roles to show
// (the matcher, the batch routes, autopilot, the copilot tools and the API routes)
// goes through the functions in this file, so there is one system and not several.
//
//   runDailyShortlist  the day's picks for one person: filtered on what they stated,
//                      ranked by what they want and their chance, one exploration pick.
//   assessJobs         the same assessment for roles on demand, without choosing a list.
//   triageRole         Interested / Not for me / Applied on one role, with undo.
//   getRoleFit         what Cello concluded about one role.
//   readShortlist      a day's list joined with each role and the person's reaction.

import { MissingKeyError } from '@/lib/harness/llm'
import type { AdminClient, DecryptedApiKeys, LlmRunner } from '@/lib/harness/types'
import { ownedJobsQuery } from '@/lib/jobs/owned-query'
import { candidateRoles, loadScoringInputs, makeEmbedder, type ScoringInputs } from './inputs'
import { assessRoles, buildShortlist, roleText, type PipelineDeps } from './pipeline'
import { wantTier } from './shortlist'
import { FIT_COLUMNS, parseFit, type FitRow } from './read'
import type { ScoringStore } from './store'
import { SupabaseScoringStore } from './supabase-store'
import { PASS_REASONS, type Chance, type PassReason, type PickKind, type Predicted, type Reaction, type RoleFit, type ShortlistPick, type Surface } from './types'

export { FIT_COLUMNS, parseFit, chanceLabel, fitHighlights, firstGapCopy, WANT_TIER_COPY } from './read'
export { PASS_REASONS } from './types'
export type { RoleFit, PassReason, Reaction, Surface, PickKind } from './types'

/** Something the caller got wrong, with a message that is safe to show. Routes turn it into a 400. */
export class ScoringInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScoringInputError'
  }
}

/** Anything that can run a query as the person: the signed-in client, or the service client. Every query here filters on the person's id. */
type Db = AdminClient

export interface ScoringContext {
  admin: AdminClient
  userId: string
  /** Without keys there is no embedding provider, so the taste similarity is skipped and the rest still works. */
  apiKeys?: DecryptedApiKeys
  llm: LlmRunner
}

function deps(ctx: ScoringContext, store: ScoringStore): PipelineDeps {
  return { llm: ctx.llm, embed: ctx.apiKeys ? makeEmbedder(ctx.apiKeys) : null, store }
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// The daily shortlist
// ---------------------------------------------------------------------------

export type LearningMode = 'stated' | 'learning' | 'calibrated'

/** How the list was ranked: from what the person said, from their reactions so far, or from a blend fitted on them. */
export function learningMode(nReactions: number, fitted: boolean): LearningMode {
  if (fitted) return 'calibrated'
  return nReactions < 3 ? 'stated' : 'learning'
}

export type ShortlistStatus = 'ok' | 'partial' | 'empty' | 'no_resume' | 'no_key'

export interface ShortlistRun {
  status: ShortlistStatus
  forDate: string
  picks: ShortlistPick[]
  /** Picks whose chance check did not finish, so they read "Not assessed yet". */
  unfinished: number
  counts: { newRoles: number; filtered: number }
  learning: { nReactions: number; mode: LearningMode }
  notes: string[]
}

export interface DailyShortlistArgs extends ScoringContext {
  forDate?: string
  size?: number
  exploreCount?: number
  /** Return the day's list as it is when one was already picked, instead of picking again. */
  skipIfBuilt?: boolean
}

export async function runDailyShortlist(args: DailyShortlistArgs): Promise<ShortlistRun> {
  const forDate = args.forDate ?? todayUtc()
  if (args.skipIfBuilt) {
    const built = await readShortlist(args.admin, args.userId, forDate)
    if (built.status === 'ready') {
      return {
        status: 'ok',
        forDate,
        picks: built.picks.map((p) => ({ jobId: p.job?.id ?? '', position: p.position, kind: p.kind, explanation: p.explanation })).filter((p) => p.jobId),
        unfinished: 0,
        counts: { newRoles: built.counts.newRoles, filtered: built.counts.filtered },
        learning: built.learning,
        notes: [],
      }
    }
  }
  const inputs = await loadScoringInputs(args.admin, args.userId)
  const base = { forDate, picks: [], unfinished: 0, counts: { newRoles: 0, filtered: 0 }, learning: { nReactions: inputs.nReactions, mode: learningMode(inputs.nReactions, false) }, notes: [] as string[] }
  if (!inputs.resumeText) return { ...base, status: 'no_resume' }

  const candidates = await candidateRoles(args.admin, args.userId, inputs.targeting, inputs.stated.titles, { limit: 60 })
  if (candidates.length === 0) return { ...base, status: 'empty' }

  const store = new SupabaseScoringStore(args.admin, args.userId)
  try {
    const result = await buildShortlist(deps(args, store), {
      userId: args.userId,
      resumeText: inputs.resumeText,
      stated: inputs.stated,
      constraints: inputs.constraints,
      candidates,
      forDate,
      size: args.size ?? 6,
      exploreCount: args.exploreCount ?? 1,
    })
    const unfinished = result.picks.filter((p) => result.assessed.find((a) => a.jobId === p.jobId)?.chance?.chance === 'cannot_assess').length
    return {
      status: result.picks.length === 0 ? 'empty' : unfinished > 0 ? 'partial' : 'ok',
      forDate,
      picks: result.picks,
      unfinished,
      counts: { newRoles: candidates.length, filtered: result.blocked.length },
      learning: { nReactions: result.taste.nReactions, mode: learningMode(result.taste.nReactions, result.taste.fitted) },
      notes: result.notes,
    }
  } catch (err) {
    if (err instanceof MissingKeyError) return { ...base, status: 'no_key', counts: { newRoles: candidates.length, filtered: 0 } }
    throw err
  }
}

export interface ShortlistView {
  forDate: string
  status: 'ready' | 'not_built'
  picks: {
    position: number
    kind: PickKind
    explanation: string
    job: { id: string; title: string; company: string; location: string | null; url: string | null; postedAt: string | null } | null
    fit: RoleFit | null
    reaction: { reaction: Reaction; reason: PassReason | null } | null
  }[]
  counts: { newRoles: number; filtered: number; notAssessed: number }
  learning: { nReactions: number; mode: LearningMode }
}

interface JobRowForView extends FitRow {
  id: string
  title: string
  location: string | null
  url: string | null
  posted_at: string | null
  companies: { name: string | null } | { name: string | null }[] | null
}

/** A day's saved list with each role's verdict and the person's own reaction. Reads only; never calls a model. */
export async function readShortlist(db: Db, userId: string, forDate: string): Promise<ShortlistView> {
  const [items, reactions, taste, unassessed, filtered] = await Promise.all([
    db.from('shortlist_items').select('job_id, position, pick_kind, explanation').eq('user_id', userId).eq('for_date', forDate).order('position', { ascending: true }),
    db.from('role_reactions').select('job_id, reaction, reason').eq('user_id', userId).not('job_id', 'is', null).limit(5000),
    db.from('taste_models').select('n_reactions, fitted').eq('user_id', userId).maybeSingle(),
    ownedJobsQuery(db, userId, 'id, companies!inner(user_id)', { count: 'exact', head: true }).is('fit_assessed_at', null),
    ownedJobsQuery(db, userId, 'id, companies!inner(user_id)', { count: 'exact', head: true }).neq('blocked_reasons', '[]'),
  ])
  const rows = (items.data as { job_id: string; position: number; pick_kind: PickKind; explanation: string }[] | null) ?? []
  const nReactions = (taste.data as { n_reactions?: number } | null)?.n_reactions ?? 0
  const fitted = (taste.data as { fitted?: boolean } | null)?.fitted === true
  const base = {
    forDate,
    counts: { newRoles: 0, filtered: filtered.count ?? 0, notAssessed: unassessed.count ?? 0 },
    learning: { nReactions, mode: learningMode(nReactions, fitted) },
  }
  if (rows.length === 0) return { ...base, status: 'not_built', picks: [] }

  const { data: jobs } = await ownedJobsQuery(db, userId, `id, title, location, url, posted_at, ${FIT_COLUMNS}, companies!inner(name)`).in('id', rows.map((r) => r.job_id))
  const byJob = new Map(((jobs as unknown as JobRowForView[] | null) ?? []).map((j) => [j.id, j]))
  const reacted = new Map(((reactions.data as { job_id: string; reaction: Reaction; reason: PassReason | null }[] | null) ?? []).map((r) => [r.job_id, r]))
  return {
    ...base,
    status: 'ready',
    counts: { ...base.counts, newRoles: rows.length },
    picks: rows.map((r) => {
      const j = byJob.get(r.job_id)
      const c = j ? (Array.isArray(j.companies) ? j.companies[0] : j.companies) : null
      const re = reacted.get(r.job_id)
      return {
        position: r.position,
        kind: r.pick_kind,
        explanation: r.explanation,
        job: j ? { id: j.id, title: j.title, company: c?.name ?? '', location: j.location, url: j.url, postedAt: j.posted_at } : null,
        fit: j ? parseFit(j) : null,
        reaction: re ? { reaction: re.reaction, reason: re.reason } : null,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Assessing roles on demand
// ---------------------------------------------------------------------------

export interface AssessJobsArgs extends ScoringContext {
  /** Assess exactly these roles, even if they were assessed before. Without them, the newest unassessed roles. */
  jobIds?: string[]
  limit?: number
}

export interface AssessJobsResult {
  assessed: number
  blocked: number
  failed: number
  /** Unassessed roles still waiting, among those worth assessing. */
  remaining: number
  skippedReason?: 'no-resume' | 'no-roles' | 'no-llm-key'
  /** The verdicts, for callers that show them straight away. */
  fits: Map<string, RoleFit>
}

export async function assessJobs(args: AssessJobsArgs): Promise<AssessJobsResult> {
  const empty = (skippedReason: AssessJobsResult['skippedReason'], remaining = 0): AssessJobsResult => ({ assessed: 0, blocked: 0, failed: 0, remaining, skippedReason, fits: new Map() })
  const inputs = await loadScoringInputs(args.admin, args.userId)
  if (!inputs.resumeText) return empty('no-resume')
  const limit = args.limit ?? 25
  const candidates = await candidateRoles(args.admin, args.userId, inputs.targeting, inputs.stated.titles, {
    limit,
    jobIds: args.jobIds,
    onlyUnassessed: !args.jobIds || args.jobIds.length === 0,
    includeReacted: true,
  })
  if (candidates.length === 0) return empty('no-roles')

  const store = new SupabaseScoringStore(args.admin, args.userId)
  try {
    const result = await assessRoles(deps(args, store), {
      userId: args.userId,
      resumeText: inputs.resumeText,
      stated: inputs.stated,
      constraints: inputs.constraints,
      candidates,
      judgePool: candidates.length,
      chanceFor: Math.min(candidates.length, 12),
    })
    const done = new Set([...result.assessed.map((a) => a.jobId), ...result.blocked.map((b) => b.jobId)])
    const fits = new Map<string, RoleFit>()
    for (const a of result.assessed) {
      fits.set(a.jobId, {
        jobId: a.jobId,
        assessedAt: new Date().toISOString(),
        blocked: [],
        want: a.want ? { p: a.want.p, reason: a.want.reason || null, tier: wantTier(a.want.p), calibrated: a.want.calibrated, nReactions: a.want.nReactions } : null,
        chance: a.chance ? { label: a.chance.chance, checks: a.chance.checks, gaps: a.chance.gaps, confirm: a.chance.confirm, note: a.chance.note } : null,
      })
    }
    for (const b of result.blocked) fits.set(b.jobId, { jobId: b.jobId, assessedAt: new Date().toISOString(), blocked: b.reasons, want: null, chance: null })
    const { count } = await ownedJobsQuery(args.admin, args.userId, 'id, companies!inner(user_id)', { count: 'exact', head: true }).is('fit_assessed_at', null)
    return {
      assessed: result.assessed.length,
      blocked: result.blocked.length,
      failed: candidates.filter((c) => !done.has(c.id)).length,
      remaining: count ?? 0,
      fits,
    }
  } catch (err) {
    if (err instanceof MissingKeyError) return empty('no-llm-key')
    throw err
  }
}

/** What Cello concluded about one role, read straight off the job row. Null when the role is not the person's. */
export async function getRoleFit(db: Db, userId: string, jobId: string): Promise<RoleFit | null> {
  const { data, error } = await ownedJobsQuery(db, userId, `id, ${FIT_COLUMNS}, companies!inner(user_id)`).eq('id', jobId).maybeSingle()
  if (error || !data) return null
  return parseFit(data as unknown as FitRow)
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export interface TriageArgs {
  /** Any client that can write as the person. Every query is filtered on userId, and the role must be theirs. */
  db: Db
  userId: string
  jobId: string
  reaction: Reaction
  reason?: PassReason | null
  note?: string | null
  surface: Surface
  pickKind?: PickKind | null
}

export interface TriageReceipt {
  reaction: Reaction
  receipt: string
}

const PASS_RECEIPTS: Record<PassReason, string> = {
  too_junior: 'Got it. Fewer roles at this level.',
  too_senior: 'Got it. Fewer roles at this level.',
  company: 'Got it. Fewer roles from this company.',
  domain: 'Got it. Fewer roles in this area.',
  location: 'Got it. Fewer roles in this place.',
  pay: 'Got it. Pay noted for this one; it will not count against similar roles.',
  other: 'Got it. Cello will show fewer like this.',
}

export function receiptFor(reaction: Reaction, reason: PassReason | null | undefined): string {
  if (reaction === 'interested') return 'Saved to Pipeline. Cello will show more like this.'
  if (reaction === 'applied') return 'Marked as applied. Cello will look for more like this.'
  return reason ? PASS_RECEIPTS[reason] : 'Got it. Cello will show fewer like this.'
}

interface JobSnapshotRow extends FitRow {
  id: string
  title: string
  location: string | null
  description: string | null
  companies: { name: string | null } | { name: string | null }[] | null
}

/** What Cello predicted for the role before the person reacted, so the blend can be fitted on how its signals really did. */
function predictedOf(row: JobSnapshotRow): Predicted | null {
  if (typeof row.want_p !== 'number') return null
  const w = (row.want_detail && typeof row.want_detail === 'object' ? row.want_detail : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  return { judge: num(w.judge), embedding: num(w.embedding), stated: num(w.stated), blended: row.want_p, chance: (row.chance as Chance | null) ?? null }
}

export async function triageRole(args: TriageArgs): Promise<TriageReceipt> {
  const { db, userId, jobId, reaction } = args
  const reason = args.reason ?? null
  if (reason && reaction !== 'not_for_me') throw new ScoringInputError('A reason belongs to a pass only.')
  if (reason && !(PASS_REASONS as readonly string[]).includes(reason)) throw new ScoringInputError('That reason is not one Cello knows.')

  const { data, error } = await ownedJobsQuery(db, userId, `id, title, location, description, ${FIT_COLUMNS}, companies!inner(name)`).eq('id', jobId).maybeSingle()
  if (error || !data) throw new ScoringInputError('That role was not found.')
  const job = data as unknown as JobSnapshotRow
  const company = (Array.isArray(job.companies) ? job.companies[0]?.name : job.companies?.name) ?? ''

  const row = {
    user_id: userId,
    job_id: jobId,
    reaction,
    reason,
    note: args.note ? args.note.slice(0, 500) : null,
    surface: args.surface,
    pick_kind: args.pickKind ?? null,
    job_title: job.title,
    company_name: company,
    job_location: job.location,
    job_text: roleText({ id: jobId, title: job.title, company, location: job.location, description: job.description }).slice(0, 4000),
    predicted: predictedOf(job),
    updated_at: new Date().toISOString(),
  }
  // The vector of the role is not known yet; a later pass embeds it and stores it on the row.
  const saved = await db.from('role_reactions').upsert(row, { onConflict: 'user_id,job_id' })
  if (saved.error) throw new Error(`could not save the reaction: ${saved.error.message}`)

  const existing = await db.from('applications').select('id, source, stage').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  const app = existing.data as { id: string; source: string | null; stage: string } | null
  if (reaction === 'interested' || reaction === 'applied') {
    if (!app) {
      const ins = await db.from('applications').insert({
        user_id: userId,
        job_id: jobId,
        stage: reaction === 'applied' ? 'applied' : 'discovered',
        applied_at: reaction === 'applied' ? new Date().toISOString() : null,
        source: 'triage',
      })
      if (ins.error) throw new Error(`could not save the role to Pipeline: ${ins.error.message}`)
    } else if (reaction === 'applied' && app.stage === 'discovered') {
      await db.from('applications').update({ stage: 'applied', applied_at: new Date().toISOString() }).eq('id', app.id).eq('user_id', userId)
    }
  } else {
    // Only an application that triage itself created is taken back. One the person made on purpose stays.
    if (app && app.source === 'triage' && app.stage === 'discovered') await db.from('applications').delete().eq('id', app.id).eq('user_id', userId)
    await db.from('jobs').update({ is_new: false }).eq('id', jobId)
  }
  // quality: emit feedback score here
  return { reaction, receipt: receiptFor(reaction, reason) }
}

/** Takes a reaction back: the reaction goes, and so does the Pipeline entry triage made for it. */
export async function undoReaction(args: { db: Db; userId: string; jobId: string }): Promise<{ undone: boolean }> {
  const { db, userId, jobId } = args
  const found = await db.from('role_reactions').select('id, reaction').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  const prior = found.data as { id: string; reaction: Reaction } | null
  if (!prior) return { undone: false }
  const del = await db.from('role_reactions').delete().eq('id', prior.id).eq('user_id', userId)
  if (del.error) throw new Error(`could not undo the reaction: ${del.error.message}`)
  const existing = await db.from('applications').select('id, source, stage').eq('user_id', userId).eq('job_id', jobId).maybeSingle()
  const app = existing.data as { id: string; source: string | null; stage: string } | null
  if (app && app.source === 'triage' && app.stage === 'discovered') await db.from('applications').delete().eq('id', app.id).eq('user_id', userId)
  if (prior.reaction === 'not_for_me') await db.from('jobs').update({ is_new: true }).eq('id', jobId)
  return { undone: true }
}

export type { ScoringInputs }
