// The resume that goes with an application: the tailored artifact attached to it (applications.resume_artifact_id,
// written by the tailor step once the person approved it or Hands-off let it through), else the newest version of
// the person's base resume (K17's store).

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBaseResume, getLatestVersionOfArtifact } from '@/lib/resume/store'

export interface ResumeRef {
  id: string
  name: string
}

export async function currentResume(admin: SupabaseClient, userId: string, artifactId?: string | null): Promise<ResumeRef | null> {
  const doc = (artifactId ? await getLatestVersionOfArtifact(admin, userId, artifactId) : null) ?? (await getBaseResume(admin, userId))
  return doc ? { id: doc.id, name: doc.title || 'Resume' } : null
}
