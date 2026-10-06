// The person's current resume: the newest version of their base resume artifact (K17's store).

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBaseResume } from '@/lib/resume/store'

export interface ResumeRef {
  id: string
  name: string
}

export async function currentResume(admin: SupabaseClient, userId: string): Promise<ResumeRef | null> {
  const doc = await getBaseResume(admin, userId)
  return doc ? { id: doc.id, name: doc.title || 'Resume' } : null
}
