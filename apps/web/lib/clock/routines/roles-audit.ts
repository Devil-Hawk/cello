// roles.audit: the daily check that what is stored agrees with the one judge. For each person with
// targets it runs keepsRole over the roles they can see (up to 2000) and writes one judge_audit row:
// how many it looked at, how many are outside, and why. T3 ("stored roles outside targets") reads the
// latest row of each person, so the measure and the list cannot disagree.
//
// A role the person saved, applied to or set aside is theirs whatever the targets say, so it is not audited.
// Code only, no model call. It stops before the slice deadline and hands on where it was.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isDemoProfile } from '../../access/guardrails'
import { loadPerson } from '../../companies/read-employer'
import { viewerRoles } from '../../jobs/person-jobs'
import { HELD_JOB, heldRole, type HeldRole } from '../../roles/rejudge'
import { keepsRole } from '../../roles/keep'
import type { RoutineContext, RoutineOutcome } from '../routines'

type Db = SupabaseClient<any, any, any>

const PEOPLE_PAGE = 50
const PAGE = 100
/** ponytail: a person's first 2000 shown roles; a sample past that needs a random page, not a longer scan. */
export const AUDIT_CAP = 2000

export interface Audit {
  rows: number
  outside: number
  by_reason: Record<string, number>
}

/** One person's audit: the judge over their shown roles, oldest id first. */
export async function auditPerson(db: Db, userId: string, targets: Parameters<typeof keepsRole>[1]): Promise<Audit> {
  const out: Audit = { rows: 0, outside: 0, by_reason: {} }
  let cursor = ''
  while (out.rows < AUDIT_CAP) {
    let q = db
      .from('person_roles')
      .select('job_id, saved_at, hidden_reason, ' + HELD_JOB)
      .eq('user_id', userId)
      .is('hidden_reason', null)
      .is('saved_at', null)
      .order('job_id')
      .limit(PAGE)
    if (cursor) q = q.gt('job_id', cursor)
    const { data, error } = await q
    if (error) throw new Error('list_shown_roles')
    const page = (data ?? []) as unknown as HeldRole[]
    if (page.length === 0) break
    cursor = page[page.length - 1].job_id
    const ids = page.map((r) => r.job_id)
    const { data: apps } = await db.from('applications').select('job_id').eq('user_id', userId).in('job_id', ids)
    const applied = new Set(((apps ?? []) as { job_id: string }[]).map((a) => a.job_id))
    const viewer = await viewerRoles(db, userId, ids)
    for (const r of page) {
      const held = heldRole(r, viewer.get(r.job_id)?.viewer_company_name)
      if (!held || applied.has(r.job_id)) continue
      out.rows++
      const verdict = keepsRole(held.role, targets)
      if (!verdict.keep) {
        out.outside++
        out.by_reason[verdict.reason] = (out.by_reason[verdict.reason] ?? 0) + 1
      }
    }
    if (page.length < PAGE) break
  }
  return out
}

export async function rolesAudit(ctx: RoutineContext): Promise<RoutineOutcome> {
  const { admin } = ctx
  let after = typeof ctx.state?.after === 'string' ? ctx.state.after : ''
  const total = { people: Number(ctx.state?.people ?? 0), rows: Number(ctx.state?.rows ?? 0), outside: Number(ctx.state?.outside ?? 0) }
  while (ctx.now() < ctx.deadlineAt) {
    let q = admin.from('profiles').select('id, is_demo, demo_expires_at').order('id').limit(PEOPLE_PAGE)
    if (after) q = q.gt('id', after)
    const { data, error } = await q
    if (error) return { ok: false, failure: 'list_profiles' }
    const page = (data ?? []) as { id: string; is_demo: boolean | null; demo_expires_at: string | null }[]
    if (page.length === 0) return { ok: true, found: total }
    for (const p of page) {
      if (ctx.now() >= ctx.deadlineAt) return { ok: true, next: { after, ...total } }
      after = p.id
      if (isDemoProfile(p)) continue
      const [person] = await loadPerson(admin, p.id)
      if (!person) continue
      let audit: Audit
      try {
        audit = await auditPerson(admin, p.id, person.targets)
      } catch {
        return { ok: false, failure: 'audit_person' }
      }
      const { error: writeError } = await admin.from('judge_audit').insert({ user_id: p.id, rows: audit.rows, outside: audit.outside, by_reason: audit.by_reason })
      if (writeError) return { ok: false, failure: 'write_audit' }
      total.people++
      total.rows += audit.rows
      total.outside += audit.outside
    }
  }
  return { ok: true, next: { after, ...total } }
}
