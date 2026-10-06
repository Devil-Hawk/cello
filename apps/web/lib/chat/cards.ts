// The card parts of an answer (directive 43). A card part stores only `{card: {kind, ref}}`; every field below is
// read from the stored row when the card is shown, never taken from model text. A role or company the person
// cannot read gives no card.

import { roleView, type Chance } from '@/lib/agents/scoring-port'
import type { AdminClient } from '@/lib/harness/types'
import { personJobs } from '@/lib/jobs/person-jobs'
import type { ObjectRef } from './types'

export interface RoleCard {
  kind: 'role'
  id: string
  title: string
  company: string | null
  companyId: string | null
  logoUrl: string | null
  place: string | null
  chance: Chance | null
  /** The pay as the posting states it; null when it states none, and then the card shows none. */
  pay: string | null
  /** The person's application stage for it, when they have one. */
  state: string | null
}

export interface CompanyCard {
  kind: 'company'
  id: string
  name: string
  logoUrl: string | null
  domain: string | null
  openCount: number
  /** How many applications the person has at it. */
  keptCount: number
  following: boolean
}

export type Card = RoleCard | CompanyCard

async function roleCard(db: AdminClient, userId: string, id: string): Promise<RoleCard | null> {
  const view = await roleView(db, userId, id)
  if (!view) return null
  const [company, application] = await Promise.all([
    view.companyId ? db.from('companies').select('logo_url').eq('id', view.companyId).eq('user_id', userId).maybeSingle() : null,
    db.from('applications').select('stage').eq('user_id', userId).eq('job_id', id).maybeSingle(),
  ])
  return {
    kind: 'role',
    id,
    title: view.title ?? 'Untitled role',
    company: view.company,
    companyId: view.companyId,
    logoUrl: (company?.data as { logo_url: string | null } | null)?.logo_url ?? null,
    place: view.location,
    chance: view.chance,
    pay: view.salary,
    state: (application.data as { stage: string } | null)?.stage ?? null,
  }
}

async function companyCard(db: AdminClient, userId: string, id: string): Promise<CompanyCard | null> {
  const { data } = await db.from('companies').select('*').eq('id', id).eq('user_id', userId).maybeSingle()
  if (!data) return null
  const row = data as { name: string; logo_url?: string | null; domain?: string | null; watching?: boolean }
  const [open, kept] = await Promise.all([
    personJobs(db).select('id', { count: 'exact', head: true }).eq('viewer_id', userId).eq('viewer_company_id', id).eq('still_open', true),
    db.from('applications').select('id, jobs!inner(company_id)', { count: 'exact', head: true }).eq('user_id', userId).eq('jobs.company_id', id),
  ])
  return {
    kind: 'company',
    id,
    name: row.name,
    logoUrl: row.logo_url ?? null,
    domain: row.domain ?? null,
    openCount: open.count ?? 0,
    keptCount: kept.count ?? 0,
    // ponytail: `watching` is the employer follow column the employers package adds; false until it exists.
    following: row.watching === true,
  }
}

/** The card for a part's subject, or null when the person cannot read it. */
export async function readCard(db: AdminClient, userId: string, card: ObjectRef): Promise<Card | null> {
  if (card.kind === 'role') return roleCard(db, userId, card.ref)
  if (card.kind === 'company') return companyCard(db, userId, card.ref)
  return null
}
