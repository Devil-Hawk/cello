// POST /api/applications/follow-up: a follow-up suggestion (+ drafted message,
// when one is due) for one application.
//
// When it is due and what to say about it is the pure rule in
// lib/pipeline/follow-up.ts. The message is written by the Writer, the same
// graph the chat uses, and saved as a message artifact draft. This route's job
// is auth, the 404 existence check, the contacts on file, and shaping the
// response components/pipeline/application-detail-dialog.tsx reads:
// {suggestion, draftMessage, suggestedContacts}, nothing else.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { BudgetCapError } from '@/lib/harness/spend'
import { followUpStep } from '@/lib/pipeline/follow-up'
import { writeMessage } from '@/lib/outreach/write'
import { setTraceMeta, setTraceOutput, withTrace } from '@/lib/trace/spans'
import { traceJobInput } from '@/lib/trace/job-input'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return withTrace(createAdminClient(), user.id, { name: 'application-follow-up' }, async () => {

    const body = await request.json()
    const { applicationId } = body
    if (!applicationId) {
      return NextResponse.json({ error: 'applicationId is required' }, { status: 400 })
    }

    // Read through the person's own session, so another person's application is a 404.
    const { data: application, error: appError } = await supabase
      .from('applications')
      .select('id, job_id, stage, applied_at')
      .eq('id', applicationId)
      .eq('user_id', user.id)
      .single()
    if (appError || !application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    const admin = createAdminClient()
    setTraceMeta({ application_id: applicationId })
    if (application.job_id) await traceJobInput(supabase, application.job_id)

    try {
      const { due, suggestion } = followUpStep(application.stage, application.applied_at ? new Date(application.applied_at) : null)
      // The contacts on file at the company, so the person can pick who to write to.
      let contacts: { id: string; name: string }[] = []
      if (application.job_id) {
        const { data: job } = await admin.from('person_jobs').select('company_id:viewer_company_id').eq('viewer_id', user.id).eq('id', application.job_id).single()
        if (job?.company_id) {
          const { data } = await admin.from('contacts').select('id, name').eq('user_id', user.id).eq('company_id', job.company_id)
          contacts = (data as { id: string; name: string }[] | null) ?? []
        }
      }
      let draftMessage: string | undefined
      if (due && (application.job_id || contacts.length > 0)) {
        // A draft that cannot be written is left out; the suggestion still answers.
        const made = await writeMessage(
          admin,
          { id: user.id, email: user.email || '' },
          { type: 'message', job_id: application.job_id ?? undefined, contact_id: contacts[0]?.id, instructions: `${suggestion} Write the message to send now.`.slice(0, 600) }
        )
        if (made.ok) draftMessage = made.written.review.body
      }
      setTraceOutput({ suggestion })
      return NextResponse.json({ suggestion, draftMessage, suggestedContacts: contacts.length > 0 ? contacts.map((c) => c.name) : undefined })
    } catch (error) {
      if (error instanceof BudgetCapError) {
        return NextResponse.json(
          { error: error.message, reason: 'spend_cap', budgetExhausted: true },
          { status: 429 }
        )
      }
      console.error('Follow-up error:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Could not draft a follow-up' },
        { status: 500 }
      )
    }
  })
}
