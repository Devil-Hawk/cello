// GET  /api/shortlist?date=YYYY-MM-DD   today's saved list with each role, its verdict and the person's reaction.
// POST /api/shortlist { refresh?, date? } builds the list when there is none (or when refresh is true).
//
// The list is picked once a day and kept, so opening the page twice never pays
// for it twice. POST answers with the same shape as GET, plus how the pick went.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm } from '@/lib/harness/llm'
import { canRunLlm, missingOpenRouterMessage } from '@/lib/harness/llm-key-message'
import type { LlmRunner } from '@/lib/harness/types'
import { runDailyShortlist, readShortlist, todayUtc } from '@/lib/scoring'
import { scoringErrorResponse } from '@/lib/scoring/http'
import { setTraceOutput, withTrace } from '@/lib/trace/spans'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(v: unknown): string | null {
  return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = request.nextUrl.searchParams.get('date')
  const forDate = raw === null ? todayUtc() : validDate(raw)
  if (!forDate) return NextResponse.json({ error: 'date must look like 2026-10-06' }, { status: 400 })
  try {
    return NextResponse.json(await readShortlist(createAdminClient(), user.id, forDate))
  } catch (err) {
    return scoringErrorResponse(err, {})
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { refresh?: unknown; date?: unknown }
  const forDate = body.date === undefined ? todayUtc() : validDate(body.date)
  if (!forDate) return NextResponse.json({ error: 'date must look like 2026-10-06' }, { status: 400 })
  const refresh = body.refresh === true

  const admin = createAdminClient()
  return withTrace(admin, user.id, { name: 'pick-shortlist' }, async () => {
    // Already picked today: answer from storage and spend nothing.
    if (!refresh) {
      const existing = await readShortlist(admin, user.id, forDate)
      if (existing.status === 'ready') return NextResponse.json({ ...existing, run: { status: 'ok', unfinished: 0 } })
    }
    const apiKeys = await loadApiKeys(admin, user.id)
    if (!canRunLlm(apiKeys)) {
      return NextResponse.json({ error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' }, { status: 400 })
    }
    try {
      const llm: LlmRunner = (opts) => callLlm(apiKeys, { ...opts, name: opts.name ?? 'pick-shortlist' })
      const run = await runDailyShortlist({ admin, userId: user.id, apiKeys, llm, forDate })
      if (run.status === 'no_key') return NextResponse.json({ error: missingOpenRouterMessage(apiKeys), skippedReason: 'no-llm-key' }, { status: 400 })
      setTraceOutput({ status: run.status, picks: run.picks.length, unfinished: run.unfinished })
      const view = await readShortlist(admin, user.id, forDate)
      return NextResponse.json({ ...view, counts: { ...view.counts, newRoles: run.counts.newRoles || view.counts.newRoles, filtered: run.counts.filtered || view.counts.filtered }, run: { status: run.status, unfinished: run.unfinished } })
    } catch (err) {
      return scoringErrorResponse(err, apiKeys)
    }
  })
}
