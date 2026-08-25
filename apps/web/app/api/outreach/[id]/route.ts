// GET/PATCH/DELETE /api/outreach/[id] — review, edit, approve, or reject a draft.
//
// PATCH accepts { subject?, body?, action? } where action ∈ 'approve' | 'reject'.
// Approving is the explicit human ok in the approve-queue; it only moves a
// 'pending_review' draft to 'approved' (never a sent/failed one). Editing subject
// or body is allowed while the message is still pending_review/approved.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { getOutreach, updateOutreach, deleteOutreach } from '@/lib/outreach/store'
import type { OutreachMessageRow } from '@/lib/outreach/types'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const message = await getOutreach(admin, user.id, params.id)
  if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true, message })
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let subject: string | undefined
  let body: string | undefined
  let action: string | undefined
  try {
    const json = await request.json()
    if (typeof json?.subject === 'string') subject = json.subject
    if (typeof json?.body === 'string') body = json.body
    if (typeof json?.action === 'string') action = json.action
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const admin = createAdminClient()
  const existing = await getOutreach(admin, user.id, params.id)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.status === 'sent') {
    return NextResponse.json({ error: 'Message already sent — cannot edit' }, { status: 409 })
  }

  const fields: Partial<OutreachMessageRow> = {}
  if (subject !== undefined) fields.subject = subject.trim() || existing.subject
  if (body !== undefined) fields.body = body.trim() || existing.body

  if (action === 'approve') {
    if (existing.status !== 'pending_review' && existing.status !== 'approved') {
      return NextResponse.json({ error: `Cannot approve a ${existing.status} message` }, { status: 409 })
    }
    fields.status = 'approved'
  } else if (action === 'reject') {
    fields.status = 'skipped'
  }

  try {
    const updated = await updateOutreach(admin, user.id, params.id, fields)
    return NextResponse.json({ ok: true, message: updated })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Update failed' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  try {
    await deleteOutreach(admin, user.id, params.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Delete failed' }, { status: 500 })
  }
}
