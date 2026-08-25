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
import { buildJudgeClient, judgeGroundedness, judgeSpecificity, JUDGE_MODEL } from '@/lib/evals/judge'
import { assertWithinBudget, recordSpend, BudgetCapError } from '@/lib/harness/spend'

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
  // buildJudgeClient always calls OpenRouter directly, regardless of which
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
    // BUDGET, enforced HERE because this path does not go through
    // lib/harness/llm.ts.
    //
    // spend.ts describes itself as "enforced at the single LLM choke point",
    // and until this route existed that was true: callLlm was the only way to
    // reach a model, so assertWithinBudget and recordSpend covered everything.
    // The judge reaches OpenRouter through autoevals instead, which needs an
    // OpenAI-compatible client rather than an injectable function — so it
    // opened a SECOND choke point, and without these two calls a user sitting
    // at their cap could keep clicking while the spend never entered the
    // ledger, quietly falsifying the remaining-budget figure every other
    // metered feature in the product reads.
    await assertWithinBudget(admin, user.id)

    const client = buildJudgeClient(apiKeys)
    const [groundedness, specificity] = await Promise.all([
      judgeGroundedness(client, { draft: message.body, sourceFacts }),
      judgeSpecificity(client, { draft: message.body, companyAndRole: `${companyName}, ${jobTitle}` }),
    ])

    // Estimated, and deliberately on the HIGH side.
    //
    // autoevals returns a score and a rationale but does not surface token
    // usage, so exact accounting is not available through this path. Silent
    // under-counting is precisely how a cap stops protecting anyone, so the
    // estimate errs upward: two calls, each roughly a resume plus a job post
    // in (~2000 tokens) and a short verdict out (~300). At JUDGE_MODEL's
    // rates this is a fraction of a cent per click — the point is that it
    // lands in the ledger at all, not that it is exact.
    await recordSpend(admin, user.id, JUDGE_MODEL, 4000, 600)

    return NextResponse.json({ ok: true, groundedness, specificity })
  } catch (e) {
    // The cap is a real answer, not a failure: say so with the same 429 the
    // rest of the product uses for "you have spent your allowance".
    if (e instanceof BudgetCapError) {
      return NextResponse.json({ error: e.message, budgetExhausted: true }, { status: 429 })
    }
    // Defense in depth: the apiKeys.openrouter check above already covers the
    // common case, but buildJudgeClient throws the same error class if that
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
