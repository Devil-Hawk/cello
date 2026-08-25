// POST /api/interview/generate  { jobId, resumeText? }
//
// Generate (or refresh) the interview prep kit for a single job: tailored
// questions + STAR stories mined ONLY from the user's real resume. Uses the
// harness interview_prep module with the signed-in user's decrypted OpenRouter
// key (loaded via the service-role client). STAR stories NEVER fabricate — that
// rule lives in the module's prompts.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { generateInterviewKit } from '@/lib/harness/agents/interview_prep'
import { getKit } from '@/lib/interview/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let jobId = ''
  let bodyResume = ''
  try {
    const body = await request.json()
    jobId = typeof body?.jobId === 'string' ? body.jobId : ''
    bodyResume = typeof body?.resumeText === 'string' ? body.resumeText : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

  const admin = createAdminClient()

  // Resume text (source of truth — never fabricated against).
  let resumeText = bodyResume.trim()
  if (!resumeText) {
    const { data: profile } = await admin
      .from('profiles')
      .select('resume_text')
      .eq('id', user.id)
      .single()
    resumeText = ((profile?.resume_text as string | null) ?? '').trim()
  }
  if (!resumeText) {
    return NextResponse.json(
      { error: 'No resume on file. Upload your resume in Settings first.', needsResume: true },
      { status: 400 }
    )
  }

  // Key check up-front (nice 400, matches resume/optimize).
  const apiKeys = await loadApiKeys(admin, user.id)
  if (!apiKeys.openrouter) {
    return NextResponse.json(
      { error: 'No OpenRouter API key configured. Add one in Settings → API keys.', needsKey: true },
      { status: 400 }
    )
  }

  // Job + company (RLS-scoped read via the signed-in client).
  const { data: job } = await supabase
    .from('jobs')
    .select('id, title, description, location, company_id, companies(id, name)')
    .eq('id', jobId)
    .single()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const companyRel = (job as { companies?: { id?: string; name?: string } | { id?: string; name?: string }[] | null })
    .companies
  const company = Array.isArray(companyRel) ? companyRel[0] : companyRel

  // Optional company dossier for company-specific questions. Read through the
  // admin client (company_dossiers isn't in the generated Database type) but
  // always scoped to this user's id.
  let dossier: { summary?: string | null; signals?: unknown } | null = null
  const companyId = (job as { company_id?: string | null }).company_id ?? null
  if (companyId) {
    const { data: dossierRow } = await admin
      .from('company_dossiers')
      .select('summary, signals')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (dossierRow) {
      dossier = {
        summary: (dossierRow as { summary?: string | null }).summary ?? null,
        signals: (dossierRow as { signals?: unknown }).signals ?? null,
      }
    }
  }

  try {
    const result = await generateInterviewKit({
      job: {
        id: (job as { id: string }).id,
        title: (job as { title: string | null }).title,
        description: (job as { description: string | null }).description,
        location: (job as { location: string | null }).location,
        company_id: companyId,
      },
      company: company ? { id: company.id ?? null, name: company.name ?? null } : null,
      dossier,
      resumeText,
      admin,
      userId: user.id,
      apiKeys,
    })

    if (result.needsResume) {
      return NextResponse.json({ error: 'No resume on file.', needsResume: true }, { status: 400 })
    }
    if (result.needsKey || !result.kitId) {
      return NextResponse.json(
        { error: 'No OpenRouter API key configured.', needsKey: true },
        { status: 400 }
      )
    }

    const kit = await getKit(admin, user.id, result.kitId)
    return NextResponse.json({ ok: true, kit, summary: result })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Interview kit generation failed' },
      { status: 500 }
    )
  }
}
