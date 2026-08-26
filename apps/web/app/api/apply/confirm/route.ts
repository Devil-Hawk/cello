// POST /api/apply/confirm — THE HUMAN CLICK. The one and only route that
// mints a submit-phase apply_phase_tokens row (ruling 8) and dispatches
// browser-apply.yml with phase='submit'.
//
// THIS ROUTE IS THE ONLY WRITER OF SUBMIT-PHASE TOKENS. That is not prose —
// see apps/web/lib/ats-apply/submit-token-chokepoint.test.ts, which scans
// every other route/graph/harness file for the same call shape and fails if
// one appears anywhere else. autopilot and every graph node reach
// application_drafts through entirely different paths (lib/graph/verify/
// cv-tailor.ts, lib/harness/agents/applier.ts) and NEVER import
// issuePhaseToken — there is no second door here to leave unlocked.
//
// Auth: session (a signed-in human), REFUSES is_demo. Requires the draft to
// be 'approved' with a review_confirmed_at that is still fresh
// (AUTHORIZATION_MAX_AGE_MS, the same 24h ceiling lib/ats-apply/capability.ts
// already uses for official-API submissions) — approving a draft days ago
// and clicking submit today is exactly the stale-authorization case that
// ceiling exists to catch.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { issuePhaseToken } from '@/lib/ats-apply/phase-tokens'
import { dispatchBrowserApplyWorkflow, DispatchError } from '@/lib/ats-apply/dispatch'
import { AUTHORIZATION_MAX_AGE_MS } from '@/lib/ats-apply'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const DEMO_REFUSAL = 'Demo workspaces cannot use assisted apply.'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  const admin = createAdminClient()

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('is_demo, demo_expires_at')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError || !profile) {
    return NextResponse.json(
      { error: "We couldn't verify your account, so nothing was submitted." },
      { status: 403, headers: NO_STORE }
    )
  }
  if (isDemoProfile(profile as DemoProfileFacts)) {
    return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403, headers: NO_STORE })
  }

  let draftId: string
  try {
    const body = await request.json()
    draftId = typeof body?.draftId === 'string' ? body.draftId : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  if (!draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400, headers: NO_STORE })

  const { data: draft, error: draftErr } = await admin
    .from('application_drafts')
    .select('id, user_id, status, review_confirmed_at')
    .eq('id', draftId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (draftErr) return NextResponse.json({ error: draftErr.message }, { status: 500, headers: NO_STORE })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404, headers: NO_STORE })

  if (draft.status !== 'approved') {
    return NextResponse.json(
      { error: `Draft is ${draft.status}, not approved — review and approve it first.` },
      { status: 409, headers: NO_STORE }
    )
  }

  const confirmedAt = draft.review_confirmed_at ? Date.parse(draft.review_confirmed_at) : NaN
  if (!Number.isFinite(confirmedAt) || Date.now() - confirmedAt > AUTHORIZATION_MAX_AGE_MS) {
    return NextResponse.json(
      { error: 'Your review confirmation is missing or has gone stale — approve the draft again.' },
      { status: 403, headers: NO_STORE }
    )
  }

  try {
    // THE ONLY MINT SITE FOR phase: 'submit'. See this file's header and
    // lib/ats-apply/submit-token-chokepoint.test.ts.
    await issuePhaseToken(admin, { draftId, userId: user.id, phase: 'submit' })
    await dispatchBrowserApplyWorkflow({ draftId, phase: 'submit' })
  } catch (err) {
    const message = err instanceof DispatchError ? err.message : 'Could not start the submit run.'
    console.error('[apply/confirm] dispatch failed', err)
    return NextResponse.json({ error: message }, { status: 502, headers: NO_STORE })
  }

  return NextResponse.json({ ok: true, status: 'approved', dispatched: true }, { headers: NO_STORE })
}
