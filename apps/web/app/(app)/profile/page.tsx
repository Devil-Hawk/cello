// /profile: what Cello knows about you, your resume and its versions, your material and accounts.
// Read on the server, because the whole preferences column is never sent to the browser
// (lib/preferences/client-safe.ts). `?tailor=<job id>` opens Tailor on that role.

import type { SupabaseClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { buildFacts } from '@/components/profile/facts'
import { ProfileScreen } from '@/components/profile/profile-screen'
import { tailorTargets, versionLabel, type AppRole } from '@/components/profile/versions'
import { listAllVersions } from '@/components/resume/versions.stub'
import { getDecryptedApiKeys } from '@/lib/apikeys'
import { canRunLlm } from '@/lib/harness/llm-key-message'
import { hasStoredGmailRefreshToken } from '@/lib/gmail/token'
import { isAllowedModel } from '@/lib/models'
import { resolveResume } from '@/lib/resume/resolve'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type Named = { name?: string | null } | { name?: string | null }[] | null
type AppRow = { jobs: { id: string; title: string; companies: Named } | { id: string; title: string; companies: Named }[] | null }
const first = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x)

export default async function ProfilePage({ searchParams }: { searchParams: { tailor?: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [profile, versions, apps, keys] = await Promise.all([
    supabase.from('profiles').select('full_name, resume_text, preferences').eq('id', user.id).maybeSingle(),
    listAllVersions(supabase as unknown as SupabaseClient, user.id),
    supabase.from('applications').select('job_id, jobs(id, title, companies(name))').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(20),
    getDecryptedApiKeys(user.id).catch(() => ({})),
  ])
  const preferences = (profile.data?.preferences ?? {}) as Record<string, unknown>

  const base = versions.filter((v) => v.job_id === null).reduce<(typeof versions)[number] | null>((a, b) => (!a || b.version > a.version ? b : a), null)
  const roles: AppRole[] = ((apps.data ?? []) as unknown as AppRow[]).flatMap((row) => {
    const job = first(row.jobs)
    return job ? [{ jobId: job.id, title: job.title, company: first(job.companies)?.name ?? null }] : []
  })

  return (
    <ProfileScreen
      facts={buildFacts({
        fullName: profile.data?.full_name ?? null,
        preferences,
        resume: base ? resolveResume(base) : null,
        resumeLabel: base ? versionLabel(base) : null,
        resumeAt: base?.created_at ?? null,
        mail: hasStoredGmailRefreshToken(preferences),
        model: isAllowedModel(preferences.model) ? preferences.model : null,
        emailCount: null, // ponytail: the count of past applications found in email arrives with K19
      })}
      versions={versions}
      fallbackText={profile.data?.resume_text ?? ''}
      targets={tailorTargets(roles, versions)}
      hasModel={canRunLlm(keys)}
      openTailor={searchParams.tailor ?? null}
    />
  )
}
