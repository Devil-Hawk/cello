// The roles worth a nudge: new, still open, and with a real chance for this person,
// most wanted first. The notifications page and the bell ask the same question, so
// they share this one query. It runs as the signed-in person: their own rows
// (person_roles) are the only ones their session can read.

import type { SupabaseClient } from '@supabase/supabase-js'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { OnJobs } from './person-roles-query'

export interface HotRole {
  id: string
  title: string
  chance: string | null
  posted_at: string | null
  discovered_at: string
  companies: { name: string | null } | null
}

type Embedded<T> = T | T[] | null

interface HotRow {
  chance: string | null
  jobs: Embedded<{
    id: string
    title: string
    posted_at: string | null
    discovered_at: string
    companies: Embedded<{ name: string | null }>
  }>
}

const HOT_SELECT = 'chance, want_p, jobs!inner(id, title, posted_at, discovered_at, companies(name))'

const first = <T>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

/** The query: a role a stated fact rules out has no chance, so it never shows here. */
export function hotRolesQuery(client: SupabaseClient, limit: number) {
  const on = new OnJobs(client.from('person_roles').select(HOT_SELECT).in('chance', ['strong', 'possible']).is('hidden_reason', null))
  on.eq('is_new', true)
  openRolesOnly(on)
  return on.query.order('want_p', { ascending: false, nullsFirst: false }).limit(limit)
}

/** The rows the query returned, as the plain role each screen lists. */
export function toHotRoles(rows: unknown): HotRole[] {
  const out: HotRole[] = []
  for (const row of (rows as HotRow[] | null) ?? []) {
    const job = first(row.jobs)
    if (!job) continue
    out.push({ id: job.id, title: job.title, chance: row.chance, posted_at: job.posted_at, discovered_at: job.discovered_at, companies: first(job.companies) })
  }
  return out
}
