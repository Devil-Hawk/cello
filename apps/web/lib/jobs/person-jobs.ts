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
