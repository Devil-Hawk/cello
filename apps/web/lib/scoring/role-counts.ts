// Counts of the person's own roles that a screen shows as a figure. They run as
// the signed-in person, so their own person_roles rows are all that is counted.

import type { SupabaseClient } from '@supabase/supabase-js'
import { openRolesOnly } from '@/lib/jobs/freshness'
import { OnJobs } from './person-roles-query'

/** Open roles Cello has not assessed for this person yet, leaving out the ones they hid. */
export function unassessedCountQuery(client: SupabaseClient) {
  const on = new OnJobs(
    client.from('person_roles').select('job_id, jobs!inner(id)', { count: 'exact', head: true }).is('assessed_at', null).is('hidden_reason', null)
  )
  openRolesOnly(on)
  return on.query
}
