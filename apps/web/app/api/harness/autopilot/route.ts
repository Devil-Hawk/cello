// POST /api/harness/autopilot — one CONTINUOUS AUTOPILOT tick.
//
// Loads every opted-in user (preferences.autopilot.enabled — the KILL SWITCH,
// see lib/graph/autopilot.ts#parseAutopilotConfig), caps the batch at
// MAX_USERS_PER_TICK, and runs lib/graph/autopilot.ts's autopilotTickGraph
// once per user via invokeGraphForUser — the same shape
// app/api/harness/cron/route.ts's own digest pass already uses for a
// per-user worker pool over invokeGraphForUser. All the guardrails live in
// that graph module (notably, autopilot NEVER auto-submits; every eligible
// job becomes a pending_review draft with a handoff link, and a real
// submission always requires a separate human-confirmed action). Guarded by
// CRON_SECRET the same way as /api/harness/cron: caller presents it as
// `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`. Invoked by
// .github/workflows/autopilot-cron.yml.
//
// FRESH THREAD EVERY TICK — no `threadId` is ever passed to
// invokeGraphForUser below, so every call mints a brand-new graph_threads
// row (see lib/graph/autopilot.ts's own header: the goal ledger, not a
// resumed checkpoint, is the sole cross-tick memory — this route never
// resumes a stalled tick the way app/api/harness/cron/route.ts's resume pass
// does for harness runs).
//
// This is the "always-on schedule" half of "AI keeps my pipeline warm while
// I'm out": the engine never stops running (fresh discovery + drafting every
// tick), disciplined by the kill switch, dedupe, quality gate, and
// official-APIs-only boundary for handoff links — never an unattended submit.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { invokeGraphForUser, type CompiledGraphLike } from '@/lib/graph/invoke'
import {
  autopilotTickGraph,
  parseAutopilotConfig,
  MAX_USERS_PER_TICK,
  USER_CONCURRENCY,
  type AutopilotUserResult,
  type ProfileRow,
} from '@/lib/graph/autopilot'
import { mapWithConcurrency } from '@/lib/ats'
import { logApiError } from '@/lib/observability/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// autopilotTickGraph (a real compiled LangGraph Pregel graph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — same
// type-only gap app/api/harness/cron/route.ts already casts around for
// harnessRunGraph.
const AUTOPILOT_GRAPH = autopilotTickGraph as unknown as CompiledGraphLike

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  const header = request.headers.get('x-cron-secret')
  return bearer === secret || header === secret
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: profiles, error } = await admin.from('profiles').select('id, full_name, email, resume_text, preferences')
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const enabled = ((profiles ?? []) as ProfileRow[]).filter((p) => parseAutopilotConfig(p.preferences).enabled)
  const batch = enabled.slice(0, MAX_USERS_PER_TICK)

  const results = await mapWithConcurrency(batch, USER_CONCURRENCY, async (profile): Promise<AutopilotUserResult> => {
    try {
      const { result } = await invokeGraphForUser({
        admin,
        userId: profile.id,
        surface: 'autopilot',
        graph: AUTOPILOT_GRAPH,
        input: { profile },
      })
      return result as AutopilotUserResult
    } catch (e) {
      logApiError('harness/autopilot', e, { userId: profile.id })
      return { userId: profile.id, message: `error: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  return NextResponse.json({ ok: true, enabledUsers: enabled.length, processed: batch.length, results })
}
