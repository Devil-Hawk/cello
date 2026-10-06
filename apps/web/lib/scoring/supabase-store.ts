// The Supabase implementation of ScoringStore. It runs with the service client,
// so every read and write is scoped by hand: a verdict is read or written only on
// the row the person has for that role (public.person_roles, keyed by user and
// job). A role the person has no row for is never assessed and never gets a
// verdict, which is also what keeps one person's conclusions off another's screen.

import type { AdminClient } from '@/lib/harness/types'
import { fromReaderRequirements, type RequirementsOutcome } from './posting-requirements'
import type { AssessmentToStore, PriorAssessment, ScoringStore, StoredTaste } from './store'
import type { Chance, ChanceResult, PassReason, Predicted, Reaction, ReactionRecord, RequirementCheck, ShortlistPick } from './types'

const REACTIONS_LIMIT = 400
const SHORTLIST_KEEP_DAYS = 14
const IN_CHUNK = 100
const WRITE_CHUNK = 8

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ---------------------------------------------------------------------------
// Chance <-> person_roles.chance + person_roles.chance_detail
// ---------------------------------------------------------------------------

const CHANCES: readonly Chance[] = ['strong', 'possible', 'stretch', 'cannot_assess']

export function chanceFromRow(chance: unknown, detail: unknown): { result: ChanceResult; resumeKey: string | null } | null {
  if (!CHANCES.includes(chance as Chance)) return null
  const d = obj(detail)
  const checks = Array.isArray(d.checks) ? (d.checks as RequirementCheck[]) : []
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    result: { chance: chance as Chance, checks, gaps: strs(d.gaps), confirm: strs(d.confirm), note: typeof d.note === 'string' ? d.note : null },
    resumeKey: typeof d.resumeKey === 'string' ? d.resumeKey : null,
  }
}

export class SupabaseScoringStore implements ScoringStore {
  constructor(
    private readonly admin: AdminClient,
    private readonly userId: string
  ) {}

  private assertUser(userId: string): void {
    if (userId !== this.userId) throw new Error('scoring store was opened for a different person')
  }

  async reactions(userId: string): Promise<ReactionRecord[]> {
    this.assertUser(userId)
    const { data, error } = await this.admin
      .from('role_reactions')
      .select('id, job_id, reaction, reason, job_title, company_name, job_location, job_text, embedding, embedding_model, predicted, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(REACTIONS_LIMIT)
    if (error) throw new Error(`could not read reactions: ${error.message}`)
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      id: String(r.id),
      jobId: (r.job_id as string | null) ?? null,
      reaction: r.reaction as Reaction,
      reason: (r.reason as PassReason | null) ?? null,
      title: String(r.job_title ?? ''),
      company: String(r.company_name ?? ''),
      location: (r.job_location as string | null) ?? null,
      text: String(r.job_text ?? ''),
      embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : null,
      embeddingModel: (r.embedding_model as string | null) ?? null,
      predicted: r.predicted && typeof r.predicted === 'object' ? (r.predicted as Predicted) : null,
      at: String(r.updated_at),
    }))
  }

  async setReactionEmbeddings(userId: string, items: { id: string; embedding: number[]; model: string }[]): Promise<void> {
    this.assertUser(userId)
    for (const part of chunks(items, WRITE_CHUNK)) {
      await Promise.all(
        part.map(async (it) => {
          const { error } = await this.admin.from('role_reactions').update({ embedding: it.embedding, embedding_model: it.model }).eq('id', it.id).eq('user_id', userId)
          if (error) console.error('[scoring] could not store a reaction vector', error.message)
        })
      )
    }
  }

  /** What each of the person's roles asks for, from the reader's own record on jobs.requirements. Roles the person has no row for are left out. */
  async requirements(userId: string, jobIds: string[]): Promise<Map<string, RequirementsOutcome>> {
    this.assertUser(userId)
    const out = new Map<string, RequirementsOutcome>()
    for (const part of chunks(jobIds, IN_CHUNK)) {
      const { data, error } = await this.admin.from('person_roles').select('job_id, jobs!inner(requirements)').eq('user_id', userId).in('job_id', part)
      if (error) throw new Error(`could not read requirements: ${error.message}`)
      for (const row of (data as unknown as { job_id: string; jobs: { requirements: unknown } | { requirements: unknown }[] | null }[] | null) ?? []) {
        const job = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs
        out.set(row.job_id, fromReaderRequirements(job?.requirements ?? null))
      }
    }
    return out
  }

  async priorAssessments(userId: string, jobIds: string[]): Promise<Map<string, PriorAssessment>> {
    this.assertUser(userId)
    const out = new Map<string, PriorAssessment>()
    for (const part of chunks(jobIds, IN_CHUNK)) {
      const { data, error } = await this.admin.from('person_roles').select('job_id, want_detail, chance, chance_detail').eq('user_id', userId).in('job_id', part)
      if (error) throw new Error(`could not read earlier assessments: ${error.message}`)
      for (const row of (data as unknown as { job_id: string; want_detail: unknown; chance: unknown; chance_detail: unknown }[] | null) ?? []) {
        const w = obj(row.want_detail)
        const c = chanceFromRow(row.chance, row.chance_detail)
        out.set(row.job_id, {
          statedP: typeof w.stated === 'number' ? w.stated : null,
          statedKey: typeof w.statedKey === 'string' ? w.statedKey : null,
          chance: c?.result ?? null,
          resumeKey: c?.resumeKey ?? null,
        })
      }
    }
    return out
  }

  async taste(userId: string): Promise<StoredTaste | null> {
    this.assertUser(userId)
    const { data, error } = await this.admin.from('taste_models').select('blend, evidence').eq('user_id', userId).maybeSingle()
    if (error) throw new Error(`could not read the taste model: ${error.message}`)
    if (!data) return null
    return { model: (data as { blend: StoredTaste['model'] }).blend, evidence: (data as { evidence: StoredTaste['evidence'] }).evidence }
  }

  async saveTaste(userId: string, taste: StoredTaste, counts: { n: number; positive: number }): Promise<void> {
    this.assertUser(userId)
    const { error } = await this.admin.from('taste_models').upsert(
      {
        user_id: userId,
        blend: taste.model,
        evidence: taste.evidence,
        n_reactions: counts.n,
        n_positive: counts.positive,
        fitted: taste.model.kind === 'fitted',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    if (error) throw new Error(`could not store the taste model: ${error.message}`)
  }

  /** Writes each verdict onto the person's own row for the role. It only updates: a role the person has no row for stays without one. */
  async saveAssessments(userId: string, rows: AssessmentToStore[]): Promise<void> {
    this.assertUser(userId)
    if (rows.length === 0) return
    const at = new Date().toISOString()
    let failed = 0
    for (const part of chunks(rows, WRITE_CHUNK)) {
      await Promise.all(
        part.map(async (r) => {
          const patch: Record<string, unknown> = { assessed_at: at, blocked_reasons: r.blockedReasons }
          if (r.blocked || !r.want) {
            // A role the person ruled out has no want and no chance worth keeping.
            Object.assign(patch, { want_p: null, want_reason: null, want_detail: null, chance: null, chance_detail: null })
          } else {
            Object.assign(patch, {
              want_p: r.want.p,
              want_reason: r.wantReason ? r.wantReason.slice(0, 300) : null,
              want_detail: {
                judge: r.want.components.judge,
                embedding: r.want.components.embedding,
                stated: r.want.components.stated,
                statedKey: r.stated?.key ?? null,
                calibrated: r.want.calibrated,
                nReactions: r.want.nReactions,
                source: 'scoring',
              },
            })
            // A role not checked this time keeps the chance it already has.
            if (r.chance) {
              Object.assign(patch, {
                chance: r.chance.chance,
                chance_detail: { checks: r.chance.checks, gaps: r.chance.gaps, confirm: r.chance.confirm, note: r.chance.note, resumeKey: r.resumeKey },
              })
            }
          }
          const { error } = await this.admin.from('person_roles').update(patch).eq('user_id', userId).eq('job_id', r.jobId)
          if (error) {
            failed++
            console.error('[scoring] could not store an assessment', error.message)
          }
        })
      )
    }
    if (failed === rows.length) throw new Error('could not store any assessment')
  }

  async saveShortlist(userId: string, forDate: string, picks: ShortlistPick[]): Promise<void> {
    this.assertUser(userId)
    const cutoff = new Date(Date.parse(`${forDate}T00:00:00Z`) - SHORTLIST_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
    const del = await this.admin.from('shortlist_items').delete().eq('user_id', userId).eq('for_date', forDate)
    if (del.error) throw new Error(`could not replace today's list: ${del.error.message}`)
    if (picks.length > 0) {
      const ins = await this.admin.from('shortlist_items').insert(
        picks.map((p) => ({ user_id: userId, for_date: forDate, job_id: p.jobId, position: p.position, pick_kind: p.kind, explanation: p.explanation }))
      )
      if (ins.error) throw new Error(`could not store today's list: ${ins.error.message}`)
    }
    const old = await this.admin.from('shortlist_items').delete().eq('user_id', userId).lt('for_date', cutoff)
    if (old.error) console.error('[scoring] could not forget old lists', old.error.message)
  }
}
