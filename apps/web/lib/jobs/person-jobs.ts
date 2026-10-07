// The roles a person holds, as one view (migration 20261008050001): the role's columns, the person's own
// company for it (viewer_company_id, viewer_company_name, ...) and their save and hidden state.
//
// The generated Database type predates the view and most of `jobs`, so a typed client reads it through an
// untyped one. A person's own client sees only their rows (row level security on person_roles); a
// service-role caller filters on viewer_id itself.

import type { SupabaseClient } from '@supabase/supabase-js'

export function personJobs(client: unknown) {
  return (client as SupabaseClient).from('person_jobs')
}

/**
 * The person's own company metadata for each role (job id to metadata), for the apply credentials. A
 * service-role read must never embed companies(metadata): that follows jobs.company_id, the company of
 * whoever stored the role first, and its apply key is theirs.
 * Callers hold at most 200 drafts, so the id list stays short.
 */
export async function viewerCompanyMetadata(admin: unknown, userId: string, jobIds: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>()
  if (jobIds.length === 0) return out
  const { data } = await personJobs(admin).select('id, viewer_company_metadata').eq('viewer_id', userId).in('id', jobIds.slice(0, 200))
  for (const r of (data ?? []) as { id: string; viewer_company_metadata: unknown }[]) out.set(r.id, r.viewer_company_metadata)
  return out
}
