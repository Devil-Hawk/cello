// Jobs have no user_id: a job belongs to the person who owns its company. These
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
 * A `jobs` query scoped to the user's own companies through the FK join instead
 * of an `.in('company_id', companyIds)` querystring array. Ownership semantics
 * are identical to RLS (the company's user_id is the person); this just does it
 * server-side against an admin client that bypasses RLS.
 *
 * `columns` must embed the join as `companies!inner(...)` (any fields): the
 * `!inner` is what turns the embed into a row-restricting join, and without it
 * the `.eq('companies.user_id', ...)` filter has nothing to attach to.
 */
export function ownedJobsQuery(admin: AdminClient, userId: string, columns: string, opts?: { count?: 'exact'; head?: boolean }) {
  return admin.from('jobs').select(columns, opts).eq('companies.user_id', userId)
}
