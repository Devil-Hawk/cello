// POST /api/harness/autopilot — one CONTINUOUS AUTOPILOT tick.
//
// Runs runAutopilotTick() across all opted-in users (guardrails baked into
// lib/harness/autopilot.ts — notably, autopilot NEVER auto-submits; every
// eligible job becomes a pending_review draft with a handoff link, and a real
// submission always requires a separate human-confirmed action). Guarded by
// CRON_SECRET the same way as /api/harness/cron: caller presents it as
// `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`. Invoked by
// .github/workflows/autopilot-cron.yml.
//
// This is the "always-on schedule" half of "AI keeps my pipeline warm while
// I'm out": the engine never stops running (fresh discovery + drafting every
// tick), disciplined by the kill switch, dedupe, quality gate, and
// official-APIs-only boundary for handoff links — never an unattended submit.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { runAutopilotTick } from '@/lib/harness/autopilot'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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
  try {
    const result = await runAutopilotTick(admin)
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
