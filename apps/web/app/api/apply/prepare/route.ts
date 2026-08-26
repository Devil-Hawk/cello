// POST /api/apply/prepare — start the FILL phase of assisted apply.
//
// Auth: session (a signed-in human), REFUSES is_demo (ruling 5, route-level
// refusal — the database trigger on apply_phase_tokens is the backstop for
// anything that forgets, same posture as every other privilege-bearing
// table in this family).
//
// Moves the draft to 'filling', mints a single-use FILL-phase token (ruling
// 8: <=15min TTL, lib/ats-apply/phase-tokens.ts), and dispatches
// .github/workflows/browser-apply.yml with `{draft_id, phase: 'fill'}` —
// see lib/ats-apply/dispatch.ts for why those two inputs are safe to log and
// why nothing secret ever rides in them. On dispatch failure the draft is
// rolled back to 'pending_review' so it is not stranded mid-phase.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'
import { issuePhaseToken } from '@/lib/ats-apply/phase-tokens'
import { dispatchBrowserApplyWorkflow, DispatchError } from '@/lib/ats-apply/dispatch'

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
      { error: "We couldn't verify your account, so nothing was started." },
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
    .select('id, user_id, job_id, status')
    .eq('id', draftId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (draftErr) return NextResponse.json({ error: draftErr.message }, { status: 500, headers: NO_STORE })
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404, headers: NO_STORE })
  if (draft.status !== 'pending_review') {
    return NextResponse.json(
      { error: `Cannot start assisted apply on a ${draft.status} draft.` },
      { status: 409, headers: NO_STORE }
    )
  }

  const { data: job } = await admin.from('jobs').select('url').eq('id', draft.job_id).maybeSingle()
  if (!job?.url) {
    return NextResponse.json({ error: 'This job has no URL to apply to.' }, { status: 422, headers: NO_STORE })
  }

  // .eq('status', 'pending_review') makes this UPDATE itself the mutex: of
  // two near-simultaneous prepare() calls for the same draft, only the one
  // that actually flips pending_review -> filling proceeds to mint a token
  // and dispatch — the loser's UPDATE matches zero rows and is refused
  // below, rather than both racing into issuePhaseToken().
  const { data: updated, error: updErr } = await admin
    .from('application_drafts')
    .update({ status: 'filling', updated_at: new Date().toISOString() })
    .eq('id', draftId)
    .eq('user_id', user.id)
    .eq('status', 'pending_review')
    .select('id')
    .maybeSingle()
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500, headers: NO_STORE })
  if (!updated) {
    return NextResponse.json(
      { error: 'This draft just changed status — refresh and try again.' },
      { status: 409, headers: NO_STORE }
    )
  }

  try {
    await issuePhaseToken(admin, { draftId, userId: user.id, phase: 'fill' })
    await dispatchBrowserApplyWorkflow({ draftId, phase: 'fill' })
  } catch (err) {
    // Roll back — a draft stuck in 'filling' with no run behind it is worse
    // than one the user can simply retry.
    await admin
      .from('application_drafts')
      .update({ status: 'pending_review', updated_at: new Date().toISOString() })
      .eq('id', draftId)
      .eq('user_id', user.id)
    const message = err instanceof DispatchError ? err.message : 'Could not start the browser run.'
    console.error('[apply/prepare] dispatch failed', err)
    return NextResponse.json({ error: message }, { status: 502, headers: NO_STORE })
  }

  return NextResponse.json({ ok: true, status: 'filling' }, { headers: NO_STORE })
}
