// POST /api/strategy/outcomes — record that the signed-in user accepted a
// lib/strategy proposal. Closes the loop lib/strategy/proposals.ts opens
// (proposals are generated, never auto-applied) by persisting the "before"
// half of a before/after comparison — see lib/strategy/measure.ts's module
// doc and supabase/migrations/20260803000001_strategy_proposal_outcomes.sql.
//
// THE SNAPSHOT IS TAKEN HERE, ON THE SERVER, RIGHT NOW. The request body only
// ever carries which proposal was accepted (id/question/title) — never a
// "before" number. A client-supplied metricsBefore would let the loop be
// gamed (report a fabricated bad baseline to guarantee "improved" later) and
// would make the whole measurement meaningless. This mirrors why
// app/api/settings/targeting/impact never trusts a client-computed count
// either — the same JobScopeCounts read lib/strategy/datasource.ts always
// does, just invoked from a different call site.
//
// GET /api/strategy/outcomes — every recorded acceptance for this user, each
// paired with today's measured effect via lib/strategy/measure.ts. Below
// either of that module's floors (MIN_OBSERVATION_WINDOW_HOURS,
// MIN_NEW_JOBS_SAMPLE) `result` comes back insufficient_data — the honest,
// expected state for anything accepted recently, not a bug.
//
// Auth pattern follows app/api/settings/targeting/route.ts: the request-scoped
// client (@/lib/supabase/server) only ever answers "who is this", every
// actual read/write against this new table goes through the service-role
// admin client (@/lib/harness/supabase-admin), matching every other agent in
// this codebase — see lib/strategy/datasource.ts's module doc.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createSupabaseStrategyDataSource, type JobScopeCounts } from '@/lib/strategy/datasource'
import { measureProposalEffect, recordAcceptedProposal, type AcceptedProposalRecord } from '@/lib/strategy/measure'
import { resolveTargeting } from '@/lib/targeting'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

interface OutcomeRow {
  id: string
  proposal_id: string
  question: string
  title: string
  accepted_at: string
  metrics_before: JobScopeCounts
}

const OUTCOME_COLUMNS = 'id, proposal_id, question, title, accepted_at, metrics_before'

function toRecord(row: Pick<OutcomeRow, 'proposal_id' | 'question' | 'title' | 'accepted_at' | 'metrics_before'>): AcceptedProposalRecord {
  return {
    proposalId: row.proposal_id,
    question: row.question,
    title: row.title,
    acceptedAt: row.accepted_at,
    metricsBefore: row.metrics_before,
  }
}

interface AcceptBody {
  proposalId: string
  question: string
  title: string
}

/** Strict shape validation for the POST body — the only three fields it may carry (see this route's header for why metricsBefore is never one of them). */
function parseBody(body: unknown): AcceptBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.proposalId !== 'string' || !b.proposalId) return null
  if (typeof b.question !== 'string' || !b.question) return null
  if (typeof b.title !== 'string' || !b.title) return null
  return { proposalId: b.proposalId, question: b.question, title: b.title }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return bad('Invalid JSON body')
  }

  const input = parseBody(body)
  if (!input) return bad('proposalId, question and title are required strings')

  const admin = createAdminClient()
  const { data: profile, error: profileErr } = await admin.from('profiles').select('preferences').eq('id', user.id).single()
  if (profileErr) console.error('[strategy/outcomes] profile fetch failed', profileErr)
  const targeting = resolveTargeting(profile?.preferences ?? {})

  // The "before" snapshot — today's job-scope numbers, under today's
  // targeting, read right now. See this file's header.
  const dataSource = createSupabaseStrategyDataSource(admin, user.id)
  const metricsBefore = await dataSource.getJobScopeCounts(targeting)
  const record = recordAcceptedProposal(input.proposalId, input.question, input.title, metricsBefore, new Date())

  const { data, error } = await admin
    .from('strategy_proposal_outcomes')
    .insert({
      user_id: user.id,
      proposal_id: record.proposalId,
      question: record.question,
      title: record.title,
      accepted_at: record.acceptedAt,
      metrics_before: record.metricsBefore,
    })
    .select(OUTCOME_COLUMNS)
    .single()

  if (error) {
    console.error('[strategy/outcomes] insert failed', error)
    return bad('Failed to record acceptance', 500)
  }

  const row = data as OutcomeRow
  return NextResponse.json({ ok: true, outcome: { id: row.id, ...toRecord(row) } })
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return bad('Unauthorized', 401)

  const admin = createAdminClient()
  const { data: rows, error } = await admin
    .from('strategy_proposal_outcomes')
    .select(OUTCOME_COLUMNS)
    .eq('user_id', user.id)
    .order('accepted_at', { ascending: false })

  if (error) {
    console.error('[strategy/outcomes] list failed', error)
    return bad('Failed to load outcomes', 500)
  }

  const { data: profile, error: profileErr } = await admin.from('profiles').select('preferences').eq('id', user.id).single()
  if (profileErr) console.error('[strategy/outcomes] profile fetch failed', profileErr)
  const targeting = resolveTargeting(profile?.preferences ?? {})

  const dataSource = createSupabaseStrategyDataSource(admin, user.id)
  // One "now" snapshot, shared across every recorded outcome below — every
  // verdict in this response is judged against the SAME instant rather than
  // a separately-refreshed read per row.
  const metricsNow = await dataSource.getJobScopeCounts(targeting)
  const now = new Date()

  const outcomes = ((rows as OutcomeRow[] | null) ?? []).map((row) => {
    const record = toRecord(row)
    return {
      id: row.id,
      ...record,
      result: measureProposalEffect(record, metricsNow, now),
    }
  })

  return NextResponse.json({ ok: true, outcomes })
}
