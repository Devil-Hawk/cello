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
import { isDemoProfile } from '@/lib/access/guardrails'
import { isCronAuthorized } from '@/lib/security/shared-secret'

export const dynamic = 'force-dynamic'
// Hobby with Fluid compute allows up to 300s. A tick stops STARTING new users
// at DEADLINE_MS so the response is written before the platform kills it.
export const maxDuration = 300
const DEADLINE_MS = 240_000

// autopilotTickGraph (a real compiled LangGraph Pregel graph) has a NARROWER
// `invoke` input type than CompiledGraphLike's own `unknown` — same
// type-only gap app/api/harness/cron/route.ts already casts around for
// harnessRunGraph.
const AUTOPILOT_GRAPH = autopilotTickGraph as unknown as CompiledGraphLike

type AutopilotCandidate = ProfileRow & { is_demo?: boolean | null; demo_expires_at?: string | null }

/**
 * The graph input is persisted to langgraph.checkpoints on a fresh thread
 * every tick, so it carries only what lib/graph/autopilot.ts reads: id,
 * resume_text, and preferences.{autopilot, targeting, searchGoals}. No api_keys,
 * gmail_sync, email, or autopilot.atsKeys ever reach a checkpoint.
 */
function slimProfile(profile: ProfileRow): ProfileRow {
  const prefs = (profile.preferences ?? {}) as Record<string, unknown>
  const { atsKeys: _atsKeys, ...autopilot } = (prefs.autopilot ?? {}) as Record<string, unknown>
  return {
    id: profile.id,
    full_name: null,
    email: null,
    resume_text: profile.resume_text,
    preferences: { autopilot, targeting: prefs.targeting, searchGoals: prefs.searchGoals },
  }
}

export async function POST(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const admin = createAdminClient()
  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, resume_text, preferences, is_demo, demo_expires_at')
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  // Demo profiles are never ticked: they would crowd the owner out of
  // MAX_USERS_PER_TICK and burn spend.
  const enabled = ((profiles ?? []) as AutopilotCandidate[]).filter(
    (p) =>
      !isDemoProfile({ is_demo: p.is_demo ?? null, demo_expires_at: p.demo_expires_at ?? null }) &&
      parseAutopilotConfig(p.preferences).enabled
  )
  const batch = enabled.slice(0, MAX_USERS_PER_TICK)

  const results = await mapWithConcurrency(batch, USER_CONCURRENCY, async (profile): Promise<AutopilotUserResult> => {
    if (Date.now() - startedAt > DEADLINE_MS) {
      return { userId: profile.id, message: 'skipped: tick deadline reached, picked up next tick' }
    }
    try {
      const { result } = await invokeGraphForUser({
        admin,
        userId: profile.id,
        surface: 'autopilot',
        graph: AUTOPILOT_GRAPH,
        input: { profile: slimProfile(profile) },
      })
      return result as AutopilotUserResult
    } catch (e) {
      logApiError('harness/autopilot', e, { userId: profile.id })
      return { userId: profile.id, message: `error: ${e instanceof Error ? e.message : String(e)}` }
    }
  })

  return NextResponse.json({ ok: true, enabledUsers: enabled.length, processed: batch.length, results })
}
