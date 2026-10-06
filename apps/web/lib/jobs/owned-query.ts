// A role is one shared row; a person holds it through their person_roles row. These
// are the two ways server code resolves that ownership, shared by the matcher,
// the batch routes and the scoring store so none of them reimplements it.

import type { AdminClient } from '@/lib/harness/types'

/**
 * Company ids owned by the user. Prefer ownedJobsQuery when selecting jobs: an
 * `.in('company_id', ids)` list stops working once an account passes ~600
 * companies, because the request URL gets too long.
 */
export async function userCompanyIds(admin: AdminClient, userId: string): Promise<string[]> {
  const { data, error } = await admin.from('companies').select('id').eq('user_id', userId)
  if (error) console.error('[jobs] userCompanyIds query failed', error)
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id)
}

/**
 * The roles userId holds (a person_roles row), through the person_jobs view instead of an
 * `.in('company_id', companyIds)` querystring array, which broke every load once an account passed
 * ~600 companies (the array crossed the request URL length limit). A role is one shared row, so
 * ownership is the person's person_roles row, not the company that stored it first. Server-side
 * against an admin client that bypasses RLS.
 *
 * Never embed `companies!inner(...)` in `columns`: a role the sweep stored has company_id null, and an
 * inner join drops it. The viewer_id filter is the fence; a name comes from viewer_company_name.
 */
export function ownedJobsQuery(admin: AdminClient, userId: string, columns: string, opts?: { count?: 'exact'; head?: boolean }) {
  return admin.from('person_jobs').select(columns, opts).eq('viewer_id', userId)
}
