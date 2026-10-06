// GET /api/drafts — the human-approve queue: this user's application_drafts,
// newest first, joined with basic job/company info. Optional ?status= filter.
//
// Auth via the cookie-scoped server client; data read through the service-role
// admin client with an explicit user_id filter (application_drafts is not in the
// generated Database type, so it goes through the untyped admin client — the
// same convention the rest of the harness uses).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { viewerRoles } from '@/lib/jobs/person-jobs'

export const dynamic = 'force-dynamic'

const VALID_STATUSES = new Set([
  'pending_review',
  'filling',
  'approved',
  'submitted',
  'rejected',
  'failed',
])

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 50))

  const admin = createAdminClient()
  let query = admin
    .from('application_drafts')
    .select(
      'id, job_id, run_id, resume_summary, cover_letter, answers, status, submission_ref, submitted_at, created_at, updated_at, fill_state, screenshots, review_confirmed_at, jobs(id, title, url, location, employer:company_directory(name, domain, logo_url))'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status && VALID_STATUSES.has(status)) {
    query = query.eq('status', status)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // A shared role is stored under the first follower's company, so no companies(...) embed here: the company is the
  // viewer's own (their role row), else the employer in the directory.
  type Rel = { name: string | null; domain: string | null; logo_url: string | null }
  type Row = { job_id: string; jobs?: { employer?: Rel | Rel[] | null } | null }
  const rows = (data ?? []) as unknown as Row[]
  const viewer = await viewerRoles(admin, user.id, rows.map((d) => d.job_id))
  const drafts = rows.map((d) => {
    if (!d.jobs) return d
    const employer = Array.isArray(d.jobs.employer) ? (d.jobs.employer[0] ?? null) : (d.jobs.employer ?? null)
    const own = viewer.get(d.job_id)
    const companies = {
      name: own?.viewer_company_name ?? employer?.name ?? null,
      domain: own?.viewer_company_domain ?? employer?.domain ?? null,
      logo_url: employer?.logo_url ?? null,
    }
    return { ...d, jobs: { ...d.jobs, companies } }
  })
  return NextResponse.json({ drafts })
}
