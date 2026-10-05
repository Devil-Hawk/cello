// POST /api/outreach/judge — quality check for ONE outreach draft: does every
// statement about the sender, the company or the role trace to a numbered line
// of the resume, job post, company research or history (groundedness), and does
// the draft carry a detail from the job post or research (specificity)? See
// lib/evals/claims-judge.ts for the judges and lib/writing/checks.ts for the
// checks that need no model.
//
// Advisory only: this never touches the message's status. The human still
// approves and sends (or doesn't) via /api/outreach/[id] and /api/outreach/send;
// this route only reports what the check found in the current text.
//
// USER-TRIGGERED ONLY — this is two real, billed model calls on the user's own
// key. It must only ever run because a signed-in human clicked "Check again" in
// components/queue/outreach-card.tsx; nothing calls this route on a schedule,
// on render, or from a webhook.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { MissingKeyError } from '@/lib/harness/providers'
import { BudgetCapError } from '@/lib/harness/spend'
import { getOutreach } from '@/lib/outreach/store'
import { judgeClaims, judgeModelFor, judgeRunner, judgeSpecificity } from '@/lib/evals/claims-judge'
import { writeVerdict } from '@/lib/evals/verdicts'
import { loadOutreachSources } from '@/lib/outreach/sources'
import { outreachSources } from '@/lib/harness/agents/outreach'
import { setTraceInput, setTraceMeta, setTraceOutput, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
// Two short classification calls: seconds, not the minutes a draft route budgets.
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return withTrace(createAdminClient(), user.id, { name: 'judge-outreach' }, async () => {

    let id: string
    try {
      const body = await request.json()
      id = typeof body?.id === 'string' ? body.id : ''
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    setTraceMeta({ outreach_id: id })

    const admin = createAdminClient()
    // getOutreach scopes by user_id — an id from the client is not proof of
    // ownership, the row lookup is.
    const message = await getOutreach(admin, user.id, id)
    if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // The same numbered sources the draft was written from.
    const loaded = await loadOutreachSources({
      supabase,
      admin,
      userId: user.id,
      userEmail: user.email || '',
      contactId: message.contact_id,
      jobId: message.job_id,
      companyId: message.company_id,
    })
    const src = outreachSources(loaded.input)
    setTraceInput({ jobTitle: loaded.input.jobTitle, companyName: loaded.input.companyName, subject: message.subject })

    const apiKeys = await loadApiKeys(admin, user.id)
    const model = judgeModelFor(apiKeys.model ?? 'anthropic/claude-sonnet-5')

    try {
      const [groundedness, specificity] = await Promise.all([
        judgeClaims(judgeRunner(apiKeys, 'judge-claims'), {
          text: message.body,
          sources: [...src.resume, ...src.job, ...src.facts, ...src.history],
        }),
        judgeSpecificity(judgeRunner(apiKeys, 'judge-specificity'), {
          text: message.body,
          jobLines: src.job,
          facts: src.facts,
          role: loaded.input.jobTitle ?? 'No specific role',
          company: loaded.input.companyName ?? 'the company',
        }),
      ])

      // eval_verdicts is the single verdict store: best-effort (writeVerdict
      // logs, never throws) so a DB hiccup never hides a result the user has.
      await Promise.all(
        [groundedness, specificity].map((v) =>
          writeVerdict(admin, {
            userId: user.id,
            subjectKind: 'outreach_draft',
            subjectId: id,
            judge: v.name === 'specificity' ? 'specificity' : 'groundedness',
            verdict: v.verdict,
            score: v.score,
            threshold: v.threshold,
            rationale: v.summary,
            model,
            judgeSpanId: v.spanId,
          })
        )
      )
      setTraceOutput({
        groundedness: { verdict: groundedness.verdict, score: groundedness.score },
        specificity: { verdict: specificity.verdict, score: specificity.score },
      })

      return NextResponse.json({ ok: true, groundedness, specificity })
    } catch (e) {
      // The cap is a real answer, not a failure: say so with the same 429 the
      // rest of the product uses for "you have spent your allowance".
      if (e instanceof BudgetCapError) {
        // REFUSE-OVER-GUESS: the refusal is itself a typed, persisted verdict, so
        // a reader of eval_verdicts can tell "not yet judged" (no row) from
        // "judged, and here is why it could not be scored" (this row).
        await Promise.all(
          (['groundedness', 'specificity'] as const).map((judge) =>
            writeVerdict(admin, {
              userId: user.id,
              subjectKind: 'outreach_draft',
              subjectId: id,
              judge,
              verdict: 'insufficient-budget',
              rationale: e.message,
            })
          )
        )
        return NextResponse.json({ error: e.message, budgetExhausted: true }, { status: 429 })
      }
      // "No key" is a setup gap, not a quality failure: a 400 with next steps.
      if (e instanceof MissingKeyError) {
        return NextResponse.json(
          { error: 'Checking a draft needs a model key. Add one in Settings, under API keys.', needsKey: true },
          { status: 400 }
        )
      }
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'The quality check failed to run' },
        { status: 502 }
      )
    }
  })
}
