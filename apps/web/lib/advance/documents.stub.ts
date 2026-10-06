// lane-stub: K17 base resume. Until K17's made-thing store has the base resume in `artifacts`, the
// person's current resume is their newest base row in resume_documents. Deleted when K17 is on main
// and the advancer reads the base resume artifact instead.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ResumeRef {
  id: string
  name: string
}

export async function currentResume(admin: SupabaseClient, userId: string): Promise<ResumeRef | null> {
  const { data } = await admin
    .from('resume_documents')
    .select('id, title, version')
    .eq('user_id', userId)
    .is('job_id', null)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { id: string; title: string | null } | null
  return row ? { id: row.id, name: row.title || 'Resume' } : null
}
