// The roles worth a nudge: new, still open, and with a real chance for this person,
// most wanted first. The notifications page and the bell ask the same question, so
// they share this one query. It runs as the signed-in person: their own rows
// (person_jobs, their person_roles joined to the posting) are the only ones their
// session can read.

import type { SupabaseClient } from '@supabase/supabase-js'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { personJobs } from '@/lib/jobs/person-jobs'

export interface HotRole {
  id: string
  title: string
  chance: string | null
  posted_at: string | null
  discovered_at: string
  /** The person's own company for the role, never the one that stored it first. */
  viewer_company_name: string | null
}

const HOT_SELECT = 'id, title, chance, want_p, posted_at, discovered_at, viewer_company_name'

/** The query: a role a stated fact rules out has no chance, so it never shows here. */
export function hotRolesQuery(client: SupabaseClient, limit: number) {
  return openRolesOnly(personJobs(client).select(HOT_SELECT).in('chance', ['strong', 'possible']).is('hidden_reason', null).eq('is_new', true))
    .order('want_p', { ascending: false, nullsFirst: false })
    .limit(limit)
}

/** The rows the query returned, as the plain role each screen lists. */
export function toHotRoles(rows: unknown): HotRole[] {
  return (rows as HotRole[] | null) ?? []
}
