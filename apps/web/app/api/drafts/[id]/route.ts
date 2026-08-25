// PATCH /api/drafts/[id]  { resume_summary?, cover_letter? }
//
// Edit a still-pending application draft's content from the approve queue. Only
// drafts in 'pending_review' are editable — once approved/submitted the content
// is frozen. Service-role write with an explicit user_id guard (application_drafts
// is not in the generated Database type, per the harness convention).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'

export const dynamic = 'force-dynamic'

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let resumeSummary: string | undefined
  let coverLetter: string | undefined
  try {
    const body = await request.json()
    if (typeof body?.resume_summary === 'string') resumeSummary = body.resume_summary
    if (typeof body?.cover_letter === 'string') coverLetter = body.cover_letter
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (resumeSummary === undefined && coverLetter === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: draft } = await admin
    .from('application_drafts')
    .select('id, status')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  if (draft.status !== 'pending_review') {
    return NextResponse.json({ error: `Cannot edit a ${draft.status} draft` }, { status: 409 })
  }

  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (resumeSummary !== undefined) fields.resume_summary = resumeSummary
  if (coverLetter !== undefined) fields.cover_letter = coverLetter

  const { data: updated, error } = await admin
    .from('application_drafts')
    .update(fields)
    .eq('id', params.id)
    .eq('user_id', user.id)
    .select('id, resume_summary, cover_letter, status, updated_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, draft: updated })
}
