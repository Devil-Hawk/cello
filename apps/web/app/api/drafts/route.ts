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

export const dynamic = 'force-dynamic'

const VALID_STATUSES = new Set([
  'pending_review',
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
      'id, job_id, run_id, resume_summary, cover_letter, answers, status, submission_ref, submitted_at, created_at, updated_at, jobs(id, title, url, location, company_id, companies(name, logo_url, domain))'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status && VALID_STATUSES.has(status)) {
    query = query.eq('status', status)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ drafts: data ?? [] })
}
