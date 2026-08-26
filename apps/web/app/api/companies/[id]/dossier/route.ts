// GET/POST /api/companies/[id]/dossier
//
// GET  -> read the current dossier for this company (admin client scoped to the
//         signed-in user).
// POST -> generate or refresh the dossier from FREE public sources: company site,
//         Wikipedia, HN, public GitHub org API; comp intel from first-party posted
//         salary ranges + public baselines; a visa signal (likely/unlikely/unknown).
//
// Degrades gracefully with no OpenRouter key: it still runs every free fetch and
// persists a PARTIAL dossier (summary=null, partial=true) rather than failing.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { generateDossier } from '@/lib/harness/agents/company_researcher'
import { getDossierByCompany, withDisplaySummaryStatus } from '@/lib/dossier/store'
import { resolveCompanyId } from '@/lib/entities/companies'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const [dossier, apiKeys] = await Promise.all([
    getDossierByCompany(admin, user.id, params.id),
    loadApiKeys(admin, user.id),
  ])
  // Resolve the missing-summary reason for DISPLAY: a row generated before the
  // user had a key reads as 'stale' (refresh would help) instead of the now-
  // wrong 'no-key' claim it was written with. See withDisplaySummaryStatus.
  return NextResponse.json({
    ok: true,
    dossier: withDisplaySummaryStatus(dossier, Boolean(apiKeys.openrouter)),
  })
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  // A merge is pure indirection (companies.canonical_id) — a stale/duplicate
  // id in the URL must still land on the survivor's ONE dossier row, not
  // regenerate a second, orphaned one keyed to the duplicate. See
  // lib/entities/companies.ts.
  const companyId = await resolveCompanyId(admin, params.id)

  // RLS-scoped read of the company + its jobs (only the owner sees them).
  const { data: company } = await supabase
    .from('companies')
    .select('id, name, domain')
    .eq('id', companyId)
    .single()
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

  const { data: jobsData } = await supabase
    .from('jobs')
    .select('salary_range, title')
    .eq('company_id', companyId)
  const jobs = (jobsData as { salary_range: string | null; title: string | null }[]) ?? []

  const apiKeys = await loadApiKeys(admin, user.id)

  try {
    const result = await generateDossier({
      company,
      jobs,
      apiKeys, // no-key path degrades to a partial dossier (never throws for a missing key)
      admin,
      userId: user.id,
    })
    const dossier = await getDossierByCompany(admin, user.id, companyId)
    // Freshly generated, so this reflects current key state already — the
    // resolver is still applied for a single consistent shape with GET.
    return NextResponse.json({
      ok: true,
      result,
      dossier: withDisplaySummaryStatus(dossier, Boolean(apiKeys.openrouter)),
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Dossier generation failed' },
      { status: 500 }
    )
  }
}
