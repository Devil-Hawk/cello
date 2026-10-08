// Everything What is working reads, in one place: the strategy report, the dimensions that need no comparison, the
// person's learnings (where their Keep and Not right choices are kept), their kept roles and the employers they
// follow. Read-only. The commands results.get, proposals.confirm and proposals.dismiss all start here.
// ponytail: the report and the shape each read the applications once; one shared read if this page ever feels slow.

import type { SupabaseClient } from '@supabase/supabase-js'
import { allLearnings } from '@/lib/learning/store'
import type { Learning } from '@/lib/learning/types'
import { resolveTargeting } from '@/lib/targeting'
import { runStrategyAnalysis } from './index'
import { createSupabaseStrategyDataSource } from './datasource'
import { shapeFindings, type Shape } from './shape'
import type { Followed, KeptRole } from './results'
import type { StrategyReport } from './types'

export interface Loaded {
  report: StrategyReport
  shape: Shape
  learnings: Learning[]
  kept: KeptRole[]
  followed: Followed
}

/** `read` is a client scoped to the person (their session, or the scoped wrapper at other doors). */
export async function loadResults(admin: SupabaseClient, read: SupabaseClient, userId: string): Promise<Loaded> {
  const { data: profile } = await admin.from('profiles').select('preferences').eq('id', userId).maybeSingle()
  const targeting = resolveTargeting((profile as { preferences?: unknown } | null)?.preferences ?? {})
  const ds = createSupabaseStrategyDataSource(admin as never, userId)
  const apps = await ds.getApplications()
  const [report, activities, outreach, learnings, roles, companies] = await Promise.all([
    runStrategyAnalysis(ds, userId, targeting),
    ds.getActivities(apps.map((a) => a.id)),
    ds.getOutreachMessages(),
    // a learnings store that cannot be read leaves every finding as new; the counts are still true
    allLearnings(userId).catch((): Learning[] => []),
    read.from('person_roles').select('chance, jobs(employer_id, company_id, source, source_tier)').is('hidden_reason', null).limit(5000),
    read.from('companies').select('id, employer_id').eq('watching', true).limit(1000),
  ])
  const followed: Followed = { employers: new Set(), companies: new Set() }
  for (const c of (companies.data ?? []) as { id: string; employer_id: string | null }[]) (c.employer_id ? followed.employers.add(c.employer_id) : followed.companies.add(c.id))
  return { report, shape: shapeFindings(apps, activities, outreach), learnings, kept: ((roles.data ?? []) as unknown as KeptRole[]), followed }
}
