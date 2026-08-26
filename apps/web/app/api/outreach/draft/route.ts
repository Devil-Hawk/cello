// POST /api/outreach/draft — draft a personalized cold-outreach email for a
// contact tied to a job/company, and store it as an outreach_message with status
// 'pending_review' (approve-queue by default). Enforces the hard dedupe guardrail
// (one initial email per contact per role). Does NOT send — see /api/outreach/send.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { findDuplicateInitial, insertOutreach } from '@/lib/outreach/store'
import type { OutreachDraftInput } from '@/lib/harness/agents/outreach'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { verifyOutreachDraft } from '@/lib/graph/verify/outreach'
import { writeVerdict } from '@/lib/evals/verdicts'
import { recordDemoEvent } from '@/lib/access/session'
import { buildOutreachContext } from '@/lib/context/assemble'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface MatchDetails {
  highlights?: unknown
  skillsMatch?: { matched?: unknown }
}

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

function highlightsFrom(matchDetails: unknown): string[] {
  const md = (matchDetails ?? {}) as MatchDetails
  const out: string[] = []
  if (Array.isArray(md.highlights)) {
    for (const h of md.highlights) if (typeof h === 'string') out.push(h)
  }
  if (out.length === 0 && md.skillsMatch && Array.isArray(md.skillsMatch.matched)) {
    for (const s of md.skillsMatch.matched) if (typeof s === 'string') out.push(s)
  }
  return out.slice(0, 6)
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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

  // Job + company context.
  let jobTitle = 'a role'
  let jobDescription: string | null = null
  let companyId: string | null = contact.company_id ?? null
  let matchHighlights: string[] = []
  if (jobId) {
    const { data: job } = await supabase
      .from('jobs')
      .select('id, title, description, company_id, match_details')
      .eq('id', jobId)
      .single()
    if (job) {
      jobTitle = job.title || jobTitle
      jobDescription = job.description ?? null
      companyId = job.company_id ?? companyId
      matchHighlights = highlightsFrom(job.match_details)
    }
  }

  let companyName = 'your company'
  if (companyId) {
    const { data: company } = await supabase
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .eq('user_id', user.id)
      .single()
    if (company) companyName = company.name
  }

  // Identity + resume (source of truth for fit claims — never fabricated).
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, resume_text')
    .eq('id', user.id)
    .single()
  const userName = profile?.full_name || user.email?.split('@')[0] || 'Me'
  const userEmail = user.email || ''

  const relationshipContext = await buildOutreachContext(admin, user.id, contactId, companyId)

  const draftInput: OutreachDraftInput = {
    userName,
    userEmail,
    jobTitle,
    companyName,
    contactName: contact.name,
    contactTitle: contact.title,
    resumeText: profile?.resume_text ?? null,
    matchHighlights,
    jobDescription,
    relationshipContext,
    kind: 'initial',
  }

  // runAgentUnit('outreach') builds its own metered LlmRunner from the
  // user's stored keys (lib/harness/keys.ts#loadApiKeys) — no more
  // makeLlmRunner/readOutreachConfig here. generateOutreachDraft (the unit's
  // own implementation, lib/harness/agents/outreach.ts) never throws — it
  // falls back to a deterministic template on any model failure — so this
  // try only exists for the infra around it (schema validation, journaling,
  // the containment check runAgentUnit always runs for this unit type).
  let draft: { subject: string; body: string; tokensUsed: number }
  let verdicts: Awaited<ReturnType<typeof verifyOutreachDraft>>['verdicts'] = []
  let judgeUnavailable = false
  try {
    const unitResult = await runUnitOnce('outreach', {
      admin,
      userId: user.id,
      goal: 'Draft outreach email',
      input: draftInput,
    })
    // VERIFY (Step 4, item 2): groundedness + specificity, one bounded
    // regeneration on failure. Never blocks persistence — the human-approve
    // queue below is already the send gate — but the final verdicts ride
    // along with whichever draft this settles on.
    const verified = await verifyOutreachDraft({
      admin,
      userId: user.id,
      goal: 'Draft outreach email (verify regeneration)',
      input: draftInput,
      draft: unitResult.output as { subject: string; body: string; tokensUsed: number },
    })
    draft = { subject: verified.subject, body: verified.body, tokensUsed: verified.tokensUsed }
    verdicts = verified.verdicts
    judgeUnavailable = verified.judgeUnavailable
  } catch (e) {
    // Whether or not OpenRouter billed for the attempt, the visitor reached
    // the paid path — which is the thing the owner is watching for.
    // Journalled and RETHROWN: what this request returns is exactly what it
    // returned before, because an audit row is not a licence to change a
    // handler's behaviour.
    await recordDraftOutcome(supabase, { outcome: 'failed', reason: 'llm_failed' }, request.headers)
    throw e
  }
  const usedLlm = draft.tokensUsed > 0

  // Only the fallible work is in the try. Precisely what that buys:
  //
  // withAuditDeadline (lib/access/audit.ts) is what stops a trail write from
  // failing this request — it converts a rejection into a message rather than
  // propagating it. THAT is the guarantee; this move is not, and an earlier
  // version of this comment wrongly claimed otherwise.
  //
  // The move buys something narrower and still worth having: a failed audit
  // cannot be caught by this handler's error path and turn a SAVED draft into a
  // 500 the user reads as "your draft was lost". See /api/contacts/source for
  // the same bug left in place — success write inside the try, catch recording
  // {outcome:'failed'}.
  let row
  try {
    row = await insertOutreach(admin, {
      user_id: user.id,
      contact_id: contactId,
      job_id: jobId,
      company_id: companyId,
      to_email: contact.email,
      to_name: contact.name,
      subject: draft.subject,
      body: draft.body,
      status: 'pending_review',
      kind: 'initial',
    })
  } catch (e) {
    // The worst outcome to leave unrecorded: the model has already been paid
    // for and there is no outreach_messages row to show for it, so without this
    // the spend is invisible in both places the owner could look.
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
  // verdict store) — written AFTER the row exists so subject_id is real, and
  // best-effort (writeVerdict never throws) so a bookkeeping hiccup can never
  // turn an already-saved draft into a 500.
  for (const verdict of verdicts) {
    await writeVerdict(admin, {
      userId: user.id,
      subjectKind: 'outreach_draft',
      subjectId: row.id,
      judge: verdict.name.includes('specificity') ? 'closed_qa' : 'factuality',
      verdict: verdict.verdict,
      score: verdict.score,
      threshold: verdict.threshold,
      rationale: verdict.summary,
    })
  }
  // verifyOutreachDraft ran into an unexpected judge failure (not the two
  // typed refusals, which stay silent — see that file's header) — REFUSE-
  // OVER-GUESS still needs a typed row here, not silence. Both judges are
  // recorded 'unjudged' because they run via Promise.all, same as
  // /api/outreach/judge's own BudgetCapError branch: there's no way to tell
  // from here which of the two calls actually threw.
  if (judgeUnavailable) {
    for (const judge of ['factuality', 'closed_qa'] as const) {
      await writeVerdict(admin, {
        userId: user.id,
        subjectKind: 'outreach_draft',
        subjectId: row.id,
        judge,
        verdict: 'unjudged',
        rationale: 'Quality check failed to run unexpectedly — draft still pending review.',
      })
    }
  }

  // `detail.count` renders as "Drafted 1 outreach message"
  // (app/api/access-codes/contract.ts). See the header block above for what may
  // and may not go in here, and what awaiting this costs.
  await recordDraftOutcome(
    supabase,
    { count: 1, stage: 'pending_review', used_llm: usedLlm },
    request.headers
  )

  return NextResponse.json({ ok: true, message: row, usedLlm })
}
