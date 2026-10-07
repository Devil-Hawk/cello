// POST /api/conversations/[id]/draft: "Draft reply" on a reply waiting in Conversations. The Writer drafts a message
// to the person who wrote, checks it once and the row joins Drafts to approve. Nothing is sent: sending is the
// person's click on that draft. The reply's stored excerpt goes in as reply_to, which the Writer frames as data
// and never follows.

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { insertOutreach } from '@/lib/outreach/store'
import { loadOutreachSources } from '@/lib/outreach/sources'
import { writeReviewVerdicts } from '@/lib/outreach/persist-review'
import { discardMessage, writeMessage } from '@/lib/outreach/write'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That message is gone.' }, { status: 404 })
  const db = supabase as unknown as SupabaseClient

  const { data: m } = await db.from('messages').select('contact_id, application_id, excerpt, subject').eq('id', params.id).eq('user_id', user.id).maybeSingle()
  const message = m as { contact_id: string | null; application_id: string | null; excerpt: string | null; subject: string } | null
  if (!message) return NextResponse.json({ error: 'That message is gone.' }, { status: 404 })
  if (!message.contact_id) return NextResponse.json({ error: 'Cello does not know who wrote this. Write the reply in Gmail.' }, { status: 409 })
  const { data: c } = await db.from('contacts').select('id, name, email, company_id').eq('id', message.contact_id).eq('user_id', user.id).maybeSingle()
  const contact = c as { id: string; name: string; email: string | null; company_id: string | null } | null
  if (!contact?.email) return NextResponse.json({ error: 'There is no address for this person. Write the reply in Gmail.' }, { status: 409 })
  const { data: a } = message.application_id ? await db.from('applications').select('job_id').eq('id', message.application_id).eq('user_id', user.id).maybeSingle() : { data: null }
  const jobId = (a as { job_id: string | null } | null)?.job_id ?? null

  const admin = createAdminClient()
  const sources = await loadOutreachSources({ supabase: db, admin, userId: user.id, userEmail: user.email || '', contactId: contact.id, jobId, companyId: contact.company_id })
  // no name, no draft: signing with a guess would be made under the person's identity
  if (!sources.senderName) return NextResponse.json({ error: 'Add your full name in Settings. Drafts are signed with it, and Cello will not guess.', needsName: true }, { status: 409 })

  const made = await writeMessage(admin, { id: user.id, email: user.email || '' }, { type: 'reply', job_id: jobId ?? undefined, contact_id: contact.id, reply_to: message.excerpt || `Subject: ${message.subject}` })
  if (!made.ok) return NextResponse.json({ error: made.error, fix: made.fix }, { status: 422 })
  const { review, artifactId, artifactVersion } = made.written
  const usedLlm = review.source === 'model'
  try {
    const row = await insertOutreach(admin, {
      user_id: user.id,
      contact_id: contact.id,
      job_id: jobId,
      company_id: sources.companyId,
      to_email: contact.email,
      to_name: contact.name,
      subject: review.subject,
      body: review.body,
      status: 'pending_review',
      kind: 'reply',
      used_llm: usedLlm,
      template_reason: usedLlm ? null : (review.templateReason ?? null),
      artifact_id: artifactId,
      artifact_version: artifactVersion,
    })
    await writeReviewVerdicts(admin, user.id, row.id, review)
    return NextResponse.json({ ok: true, id: row.id })
  } catch {
    await discardMessage(admin, user.id, artifactId)
    return NextResponse.json({ error: 'Could not save the draft. Try again.' }, { status: 500 })
  }
}
