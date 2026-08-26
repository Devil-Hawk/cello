// POST /api/agents/analyze — AI insights for ONE job.
//
// HONESTY CONTRACT: this route returns analysis the model actually produced
// about this job, or it returns an error saying why it could not. There is no
// third option — see lib/harness/agents/analyst.ts's own header for the full
// history (a deleted createFallbackResponse() used to answer a parse failure
// with hardcoded generic advice in the shape of a real analysis).
//
// Everything that used to live here — building a Job/Company/UserProfile out
// of three separate reads, constructing a provider client, and the hand-
// placed assertWithinBudget/recordSpend this route needed because that
// client bypassed callLlm entirely — is gone. lib/graph/oneshot.ts#
// runUnitOnce -> lib/graph/unit.ts#runAgentUnit('analyst') now does the DB
// reads, the metered/demo-gated model call, and the journaling; this route's
// only job is auth, the jobId check, and translating whatever the unit threw
// into the HTTP shape components/jobs/job-detail-modal.tsx already reads.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runUnitOnce } from '@/lib/graph/oneshot'
import { AnalystError, type AnalystErrorCode } from '@/lib/harness/agents/analyst'
import { BudgetCapError } from '@/lib/harness/spend'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * HTTP status per cause. Split by whose problem it is: 400 when the user has
 * something to fix (no resume, no/bad key), 429 when they must wait (rate
 * limit), 502 when the model answered with something unusable — that last
 * group is OUR failure and must never be dressed up as a result.
 */
const STATUS_BY_CODE: Record<AnalystErrorCode, number> = {
  no_resume: 400,
  no_api_key: 400,
  provider_auth: 400,
  rate_limited: 429,
  provider_error: 502,
  empty_response: 502,
  unparseable_response: 502,
  incomplete_response: 502,
}

/** Causes whose fix lives in Settings, flagged so the UI can offer that link
 *  next to the retry — clicking retry changes nothing until the key is fixed. */
const NEEDS_KEY: ReadonlySet<AnalystErrorCode> = new Set<AnalystErrorCode>(['no_api_key', 'provider_auth'])

function failureResponse(failure: AnalystError) {
  console.error('[analyze] analysis failed', { code: failure.code, providerStatus: failure.providerStatus })
  return NextResponse.json(
    {
      error: failure.message,
      reason: failure.code,
      retryable: failure.retryable,
      ...(NEEDS_KEY.has(failure.code) ? { needsKey: true } : {}),
    },
    { status: STATUS_BY_CODE[failure.code] ?? 500 }
  )
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { jobId } = body
  if (!jobId || typeof jobId !== 'string') {
    return NextResponse.json({ error: 'jobId is required' }, { status: 400 })
  }

  const admin = createAdminClient()

  try {
    const result = await runUnitOnce('analyst', {
      admin,
      userId: user.id,
      goal: `Analyze job ${jobId}`,
      input: { jobId },
    })
    // AnalystOutput is exactly {summary, talkingPoints, companyInsights,
    // interviewTips} — the response IS the unit's output, unwrapped.
    return NextResponse.json(result.output)
  } catch (error) {
    // The cap is an answer, not a crash: the user is told they are out of
    // allowance, with the same 429 the rest of the product uses.
    if (error instanceof BudgetCapError) {
      return NextResponse.json(
        { error: error.message, reason: 'spend_cap', retryable: false, budgetExhausted: true },
        { status: 429 }
      )
    }
    if (error instanceof AnalystError) {
      return failureResponse(error)
    }
    // Unclassified — a schema-validation failure, a journal write error, an
    // unexpected throw. Never dressed up as a result.
    console.error('Analyze error:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to analyze job',
        reason: 'provider_error' satisfies AnalystErrorCode,
        retryable: true,
      },
      { status: 502 }
    )
  }
}
