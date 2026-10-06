// POST /api/outreach/draft — draft a personalized cold-outreach email for a
// contact tied to a job/company, and store it as an outreach_message with status
// 'pending_review' (approve-queue by default). Enforces the hard dedupe guardrail
// (one initial email per contact per role). Does NOT send — see /api/outreach/send.
//
// A draft is signed with the user's full name from their profile, never a guess:
// with no name on file the route answers 409 {needsName: true} before any model
// is called. The stored row records whether a model wrote the text and, when it
// is the standard template, why, so the card can say so.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { findDuplicateInitial, insertOutreach, isDuplicateOutreachError } from '@/lib/outreach/store'
import { discardMessage, writeMessage } from '@/lib/outreach/write'
import type { OutreachReview } from '@/lib/graph/verify/outreach-review'
import { loadOutreachSources } from '@/lib/outreach/sources'
import { writeReviewVerdicts } from '@/lib/outreach/persist-review'
import { recordDemoEvent } from '@/lib/access/session'
import { setTraceInput, setTraceMeta, setTraceOutput, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// --- the demo trail ----------------------------------------------------
//
// "We should be able to see what someone did with a particular access code."
// Drafting spends the owner's LLM budget on every request that gets as far as
// the model, so both outcomes are journalled: the draft that was written, and
// the attempt that was not.
//
// WHAT THESE CALLS COST, STATED HONESTLY. recordDemoEvent writes nothing for an
// ordinary user, but it is NOT a no-op for one — it pays an auth round trip and
// a service-role profile read before it can know that. It never throws AND
// never takes longer than AUDIT_DEADLINE_MS (lib/access/audit.ts); those two
// together are what let it be awaited on a response path without an unanswered
// insert eating this handler's maxDuration and turning a 200 into a gateway
// timeout. It is awaited rather than backgrounded because a Next 14 handler has
// no after()/waitUntil, so a floating promise is an event lost when the process
// is torn down after the response.
//
// NOTHING ABOUT THE MESSAGE ITSELF ever goes in: not the subject, not the body,
// not the recipient's name or address. The owner learns that a draft was
// attempted, for which stage of the flow, and whether a model wrote it — which
// is the shape of the session, which is all this table is allowed to hold.

/** Trail rows for one drafting attempt. `reason` is an enum THIS FILE chooses,
 *  never a caught error's message: a message is prose, and prose is where the
 *  recipient's name and the draft's contents would ride into the table. */
async function recordDraftOutcome(
  supabase: Awaited<ReturnType<typeof createClient>>,
  detail: Record<string, unknown>,
  headers: Headers
): Promise<void> {
  await recordDemoEvent(supabase, {
    kind: 'action',
    action: 'outreach.draft',
    target: '/contacts',
    detail,
    headers,
  })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return withTrace(createAdminClient(), user.id, { name: 'draft-outreach' }, async () => {

    let contactId: string
    let jobId: string | null = null
    try {
      const body = await request.json()
      contactId = typeof body?.contactId === 'string' ? body.contactId : ''
      if (typeof body?.jobId === 'string' && body.jobId) jobId = body.jobId
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!contactId) return NextResponse.json({ error: 'contactId is required' }, { status: 400 })
    setTraceMeta({ contact_id: contactId, ...(jobId ? { job_id: jobId } : {}) })

    // Contact (must be the user's own, and reachable by email).
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, name, email, title, company_id')
      .eq('id', contactId)
      .eq('user_id', user.id)
      .single()
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    if (!contact.email) {
      return NextResponse.json({ error: 'Contact has no email address to reach' }, { status: 400 })
    }

    const admin = createAdminClient()

    // Guardrail (3): hard dedupe — no repeat pestering.
    const dupe = await findDuplicateInitial(admin, user.id, contactId, jobId)
    if (dupe) {
      // A refusal, not a failure — but still the answer to "what did they do with
      // my code", and the row that separates "never tried" from "kept trying to
      // re-mail the same person".
      await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'duplicate' }, request.headers)
      return NextResponse.json(
        { error: 'An outreach email to this contact for this role already exists.', existing: dupe },
        { status: 409 }
      )
    }

    // The job post, company research, earlier contact and the sender's identity
    // and resume: the sources the draft is written from and checked against.
    const sources = await loadOutreachSources({
      supabase,
      admin,
      userId: user.id,
      userEmail: user.email || '',
      contactId,
      jobId,
      companyId: contact.company_id ?? null,
    })
    // No name, no draft: signing with the email's local part would be a guess
    // made under the user's identity.
    if (!sources.senderName) {
      await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'needs_name' }, request.headers)
      return NextResponse.json(
        { error: 'Add your full name in Settings first. Drafts are signed with it.', needsName: true },
        { status: 409 }
      )
    }
    const companyId = sources.companyId

    // What a reviewer needs at a glance in Langfuse (the ids are in the trace metadata).
    setTraceInput({ jobTitle: sources.input.jobTitle, companyName: sources.input.companyName })

    // The Writer drafts, checks once and saves the text as a message artifact; the row below queues that version.
    // It never throws for a model failure: the standard template stands in and the reason is recorded.
    let review: OutreachReview
    let written: { artifactId: string; artifactVersion: number }
    try {
      const made = await writeMessage(admin, { id: user.id, email: user.email || '' }, { type: 'message', job_id: jobId ?? undefined, contact_id: contactId })
      if (!made.ok) {
        await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'llm_failed' }, request.headers)
        return NextResponse.json({ error: made.error, fix: made.fix }, { status: 422 })
      }
      review = made.written.review
      written = made.written
    } catch (e) {
      // Whether or not OpenRouter billed for the attempt, the visitor reached
      // the paid path, which is the thing the owner is watching for.
      // Journalled and RETHROWN: what this request returns is exactly what it
      // returned before, because an audit row is not a licence to change a
      // handler's behaviour.
      await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'llm_failed' }, request.headers)
      throw e
    }
    const usedLlm = review.source === 'model'
    const templateReason = usedLlm ? null : (review.templateReason ?? null)

    // Only the fallible work is in the try. withAuditDeadline (lib/access/audit.ts)
    // is what stops a trail write from failing this request; keeping the save in
    // its own try means a failed audit cannot turn a SAVED draft into a 500.
    let row
    try {
      row = await insertOutreach(admin, {
        user_id: user.id,
        contact_id: contactId,
        job_id: jobId,
        company_id: companyId,
        to_email: contact.email,
        to_name: contact.name,
        subject: review.subject,
        body: review.body,
        status: 'pending_review',
        kind: 'initial',
        used_llm: usedLlm,
        template_reason: templateReason,
        artifact_id: written.artifactId,
        artifact_version: written.artifactVersion,
      })
    } catch (e) {
      await discardMessage(admin, user.id, written.artifactId)
      // Two drafts for the same contact and role raced past the check above and
      // the unique index caught the loser. That is the duplicate refusal, not a
      // server fault.
      if (isDuplicateOutreachError(e)) {
        await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'duplicate', used_llm: usedLlm }, request.headers)
        return NextResponse.json(
          { error: 'An outreach email to this contact for this role already exists.' },
          { status: 409 }
        )
      }
      // The worst outcome to leave unrecorded: the model has already been paid
      // for and there is no outreach_messages row to show for it.
      await recordDraftOutcome(
        supabase,
        { outcome: 'failed', reason: 'save_failed', used_llm: usedLlm },
        request.headers
      )
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Failed to save draft' },
        { status: 500 }
      )
    }

    // Verdicts ride along with the row they judged (eval_verdicts: the single
    // verdict store), written AFTER the row exists so subject_id is real, and
    // best-effort so a bookkeeping hiccup never turns a saved draft into a 500.
    await writeReviewVerdicts(admin, user.id, row.id, review)

    // `detail.count` renders as "Drafted 1 outreach message"
    // (app/api/access-codes/contract.ts). See the header block above for what may
    // and may not go in here, and what awaiting this costs.
    await recordDraftOutcome(
      supabase,
      { count: 1, stage: 'pending_review', used_llm: usedLlm },
      request.headers
    )

    // A draft sent without a judge key looks like a judged one unless it says so.
    const judge = review.judgeUnavailable ? 'failed' : review.verdicts.length > 0 ? 'ran' : 'skipped'
    setTraceMeta({ message_id: row.id, judge })
    setTraceOutput({
      subject: review.subject,
      usedLlm,
      templateReason,
      judge,
      verdicts: review.verdicts.map((v) => ({ name: v.name, verdict: v.verdict, score: v.score })),
      checksFailed: review.checks.checks.filter((c) => !c.ok).map((c) => c.id),
    })
    return NextResponse.json({ ok: true, message: row, usedLlm, templateReason, checks: review.checks })
  })
}
