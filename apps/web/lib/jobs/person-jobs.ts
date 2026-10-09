// The roles a person holds, as one view (migration 20261008050001): the role's columns, the person's own
// company for it (viewer_company_id, viewer_company_name, ...) and their save and hidden state.
//
// The generated Database type predates the view and most of `jobs`, so a typed client reads it through an
// untyped one. A person's own client sees only their rows (row level security on person_roles); a
// service-role caller filters on viewer_id itself.

import type { SupabaseClient } from '@supabase/supabase-js'
import { FIT_COLUMNS, type FitRow } from '@/lib/scoring/read'

export function personJobs(client: unknown) {
  return (client as SupabaseClient).from('person_jobs')
}

/** What a person's own role row says: their company for it, and their verdict (chance, want). */
export interface ViewerRole extends FitRow {
  viewer_company_id: string | null
  viewer_company_name: string | null
  viewer_company_domain: string | null
  viewer_company_metadata: unknown
}

/**
 * The person's own company for each role (job id to row), and with `fit` their verdict on it too. A service-role read of a role
 * must never embed companies(...): that follows jobs.company_id, the company of whoever stored the role
 * first, and its name, logo, domain and apply key are theirs. Name a role by this row, else by the
 * directory employer.
 * Callers hold at most 200 drafts, so the id list stays short.
 */
export async function viewerRoles(admin: unknown, userId: string, jobIds: string[], opts: { fit?: boolean } = {}): Promise<Map<string, ViewerRole>> {
  const out = new Map<string, ViewerRole>()
  if (jobIds.length === 0) return out
  const { data } = await personJobs(admin)
    .select('id, viewer_company_id, viewer_company_name, viewer_company_domain, viewer_company_metadata' + (opts.fit ? ', ' + FIT_COLUMNS : ''))
    .eq('viewer_id', userId)
    .in('id', jobIds.slice(0, 200))
  for (const r of (data ?? []) as unknown as (ViewerRole & { id: string })[]) out.set(r.id, r)
  return out
}
