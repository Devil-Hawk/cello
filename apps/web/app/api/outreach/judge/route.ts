// POST /api/outreach/judge — LLM-as-judge quality check for ONE outreach draft:
// does it invent something the resume/job facts don't support (groundedness),
// and is it actually about this company and role or interchangeable boilerplate
// (specificity)? See lib/evals/judge.ts for the scorers themselves.
//
// Advisory only: this never touches the message's status. The human still
// approves and sends (or doesn't) via /api/outreach/[id] and /api/outreach/send;
// this route only reports what a judge model thinks of the current text.
//
// USER-TRIGGERED ONLY — this is a real, billed model call (two of them). It
// must only ever run because a signed-in human clicked "Check this draft" in
// components/queue/outreach-card.tsx; nothing calls this route on a schedule,
// on render, or from a webhook.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { MissingKeyError } from '@/lib/harness/llm'
import { getOutreach } from '@/lib/outreach/store'
import { meteredJudgeClient, judgeGroundedness, judgeSpecificity, JUDGE_MODEL } from '@/lib/evals/judge'
import { writeVerdict } from '@/lib/evals/verdicts'
import { assertWithinBudget, BudgetCapError } from '@/lib/harness/spend'

export const dynamic = 'force-dynamic'
// Two short classification calls (a few hundred tokens each) — seconds, not
// the minutes a draft-generation route budgets for.
export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let id: string
  try {
    const body = await request.json()
    id = typeof body?.id === 'string' ? body.id : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const admin = createAdminClient()
  // getOutreach scopes by user_id — an id from the client is not proof of
  // ownership, the row lookup is.
  const message = await getOutreach(admin, user.id, id)
  if (!message) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const apiKeys = await loadApiKeys(admin, user.id)
  // meteredJudgeClient always calls OpenRouter directly, regardless of which
  // backend the account has selected for drafting/matching (see judge.ts's
  // header comment on why autoevals needs its own OpenAI-compatible client) —
  // so this checks the raw key, not canRunLlm()/the active provider. "No key"
  // is a setup gap, not a quality failure, so it's a 400 with next steps, not
  // a 500.
  if (!apiKeys.openrouter) {
    return NextResponse.json(
      {
        error:
          'Checking a draft needs an OpenRouter key — the quality check calls OpenRouter directly, ' +
          'even if you draft with a different provider. Add one in Settings → API keys.',
        needsKey: true,
      },
      { status: 400 }
    )
  }

  // Job + company context this draft is allowed to draw on — same shape
  // /api/outreach/follow-up builds from a prior message's stored job_id/company_id.
  let jobTitle = 'a role'
  let jobDescription: string | null = null
  if (message.job_id) {
    const { data: job } = await supabase
      .from('jobs')
      .select('title, description')
      .eq('id', message.job_id)
      .single()
    if (job) {
      jobTitle = job.title || jobTitle
      jobDescription = job.description ?? null
    }
  }

  let companyName = 'the company'
  if (message.company_id) {
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', message.company_id)
      .eq('user_id', user.id)
      .single()
    if (company) companyName = company.name
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('resume_text')
    .eq('id', user.id)
    .single()

  const sourceFacts =
    `Resume: ${profile?.resume_text?.trim() || 'No resume on file.'}\n\n` +
    `Job post: ${jobTitle} at ${companyName}.${jobDescription ? ` ${jobDescription}` : ''}`

  try {
    // Fail fast, BEFORE building a client or making any request: a user
    // already at their cap gets the same 429 they'd get from
    // meteredJudgeClient's own per-request check below (see judge.ts's
    // meteredFetch), just without the wasted round trip. Redundant with that
    // per-call check by design, NOT with its recordSpend half — this route
    // used to also record its own post-call estimate here, but
    // meteredJudgeClient's fetch wrapper now records real usage per request
    // (proven covering both calls below in lib/evals/judge.test.ts), so a
    // second manual recordSpend would double-bill the same two calls.
    await assertWithinBudget(admin, user.id)

    const client = meteredJudgeClient(admin, user.id, apiKeys)
    const [groundedness, specificity] = await Promise.all([
      judgeGroundedness(client, { draft: message.body, sourceFacts }, { userId: user.id }),
      judgeSpecificity(
        client,
        { draft: message.body, companyAndRole: `${companyName}, ${jobTitle}` },
        { userId: user.id }
      ),
    ])

    // The audited dead end closes here: eval_verdicts is the single verdict
    // store (design doc), and until now a judged draft's verdict lived only
    // in the HTTP response — gone the moment the page reloaded. Best-effort
    // (writeVerdict logs, never throws) so a DB hiccup never hides a judge
    // result the user already has in front of them.
    await Promise.all([
      writeVerdict(admin, {
        userId: user.id,
        subjectKind: 'outreach_draft',
        subjectId: id,
        judge: 'factuality',
        verdict: groundedness.verdict,
        score: groundedness.score,
        threshold: groundedness.threshold,
        rationale: groundedness.summary,
        model: JUDGE_MODEL,
      }),
      writeVerdict(admin, {
        userId: user.id,
        subjectKind: 'outreach_draft',
        subjectId: id,
        judge: 'closed_qa',
        verdict: specificity.verdict,
        score: specificity.score,
        threshold: specificity.threshold,
        rationale: specificity.summary,
        model: JUDGE_MODEL,
      }),
    ])

    return NextResponse.json({ ok: true, groundedness, specificity })
  } catch (e) {
    // The cap is a real answer, not a failure: say so with the same 429 the
    // rest of the product uses for "you have spent your allowance".
    if (e instanceof BudgetCapError) {
      // REFUSE-OVER-GUESS (invariant 7): the refusal is itself a typed,
      // persisted verdict, not silence — a reader of eval_verdicts for this
      // draft can tell "not yet judged" (no row) apart from "judged, and
      // here is why we couldn't score it" (this row). Both judges are
      // recorded because Promise.all above rejects on the FIRST rejection —
      // there is no way to tell from here which of the two calls actually
      // reached OpenRouter and which never started.
      await Promise.all(
        (['factuality', 'closed_qa'] as const).map((judge) =>
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
    // Defense in depth: the apiKeys.openrouter check above already covers the
    // common case, but meteredJudgeClient throws the same error class if that
    // ever races (e.g. the key is revoked between the check and this call).
    if (e instanceof MissingKeyError) {
      return NextResponse.json({ error: e.message, needsKey: true }, { status: 400 })
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'The quality check failed to run' },
      { status: 502 }
    )
  }
}
