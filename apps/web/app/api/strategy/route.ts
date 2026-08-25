// GET /api/strategy — Cello's strategy analytics: honest answers to the eight
// questions in lib/strategy/questions/*.ts, plus proposed campaign changes for
// the user to approve. Read-only: this route never writes to applications,
// resume_documents, or profiles.preferences.targeting — see
// lib/strategy/proposals.ts's module doc for why proposals stay data, not
// side effects.
//
// Query params:
//   ?demo=synthetic — bypass the real database entirely and answer from
//     lib/strategy/fixtures.ts's in-memory synthetic dataset instead. Exists
//     to demonstrate the 'answered' path (every question crosses its honesty
//     threshold) without needing 50 real applications — the default,
//     unparameterized call always reads the signed-in user's real data, and
//     is expected to report insufficient_data on every outcome question until
//     the account has real volume. Never touches the DB in demo mode, not
//     even to read the user's targeting (a neutral, unconfigured Targeting is
//     used instead — see lib/harness/agents/strategist.ts).
//
// Same core (runStrategyAnalysis) as lib/harness/agents/strategist.ts, which
// is NOT yet wired into the harness DAG — see that file's coordination note.
// Both paths stay in sync because both call the same function.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runStrategyAnalysis } from '@/lib/strategy'
import { createSupabaseStrategyDataSource } from '@/lib/strategy/datasource'
import { buildSyntheticFixture } from '@/lib/strategy/fixtures'
import { resolveTargeting, EMPTY_TARGETING } from '@/lib/targeting'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isSyntheticDemo = request.nextUrl.searchParams.get('demo') === 'synthetic'

  try {
    if (isSyntheticDemo) {
      const report = await runStrategyAnalysis(buildSyntheticFixture(), user.id, EMPTY_TARGETING)
      return NextResponse.json({ ok: true, demo: 'synthetic', report })
    }

    const admin = createAdminClient()
    const { data: profile, error: profileErr } = await admin.from('profiles').select('preferences').eq('id', user.id).single()
    if (profileErr) console.error('[strategy] profile fetch failed', profileErr)
    const targeting = resolveTargeting(profile?.preferences ?? {})

    const dataSource = createSupabaseStrategyDataSource(admin, user.id)
    const report = await runStrategyAnalysis(dataSource, user.id, targeting)
    return NextResponse.json({ ok: true, demo: null, report })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Strategy analysis failed'
    console.error('[strategy] analysis failed', e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
