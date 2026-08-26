// POST /api/drafts/reject  { draftId }
//
// Removes a draft from the approve queue (status 'rejected'). Never submits.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let draftId: string
  try {
    const body = await request.json()
    draftId = typeof body?.draftId === 'string' ? body.draftId : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: draft, error: draftErr } = await admin
    .from('application_drafts')
    .select('id, status')
    .eq('id', draftId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (draftErr) return NextResponse.json({ error: draftErr.message }, { status: 500 })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
  if (draft.status === 'submitted') {
    return NextResponse.json({ error: 'Cannot reject an already-submitted application' }, { status: 409 })
  }

  const now = new Date().toISOString()
  const { error: updErr } = await admin
    .from('application_drafts')
    .update({ status: 'rejected', reviewed_at: now, updated_at: now })
    .eq('id', draftId)
    .eq('user_id', user.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, status: 'rejected' })
}
