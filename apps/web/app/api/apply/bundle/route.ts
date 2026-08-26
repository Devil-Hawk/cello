// POST /api/apply/bundle — the ONLY thing the browser-runner (packages/
// scrapers/src/apply_fill.py, apply_submit.py) is ever handed.
//
// Auth is TWO factors, both required (ruling 8):
//   1. BROWSER_RUNNER_SECRET — a static, transport-level shared secret baked
//      into browser-apply.yml's own environment (never a workflow_dispatch
//      INPUT, which GitHub logs in plain text). Proves "this really is our
//      GitHub Actions job", nothing more — it authorizes NO specific draft.
//   2. An unconsumed, unexpired apply_phase_tokens row for exactly the
//      (draft_id, phase) the caller names — consumed here, atomically,
//      before anything is released (lib/ats-apply/phase-tokens.ts).
//
// Once consumed, this route mints a REPORT TOKEN (mintReportToken()) and
// returns its plaintext in the response body below — a channel
// workflow_dispatch's logged inputs never touch. The runner must present it
// back to PATCH app/api/apply/state (verifyReportToken()) before that route
// will record a fill/submit result: proof this exact run actually fetched a
// bundle, not just knowledge of BROWSER_RUNNER_SECRET + the (draftId, phase)
// pair GitHub's own run logs already make visible.
//
// HOST-SCOPED CREDENTIAL RELEASE: the scraping tier can never obtain a
// credential for a host other than the one the job actually posts to —
// lib/apply/vault.ts#resolveCredentialFor is asked for exactly job's host
// (normalizeHost(job.url)), the same exact-match discipline
// apply_credentials' own migration requires. No credential is released when
// none is stored for that host; assisted apply still proceeds (the runner
// fills what it can and a human finishes any login wall).
//
// PHASE-SPECIFIC RULES:
//   fill   — releases profile + resume + cover letter + the job URL. No
//            further gate beyond the consumed token.
//   submit — additionally requires draft.status = 'approved' AND a
//            review_confirmed_at within AUTHORIZATION_MAX_AGE_MS (ruling 8).
//            Answers are draft.fill_state VERBATIM — the exact thing a human
//            reviewed — never recomputed, so apply_submit.py re-fills
//            byte-for-byte rather than asking the model to answer again.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { consumePhaseToken, mintReportToken, type ApplyPhase } from '@/lib/ats-apply/phase-tokens'
import { buildApplyProfile, AUTHORIZATION_MAX_AGE_MS } from '@/lib/ats-apply'
import { normalizeHost, resolveCredentialFor } from '@/lib/apply/vault'
import { getBaseResume, getLatestVersion } from '@/lib/resume/store'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.BROWSER_RUNNER_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  return bearer === secret
}

interface DraftRow {
  id: string
  user_id: string
  job_id: string
  status: string
  resume_summary: string | null
  cover_letter: string | null
  fill_state: unknown
  review_confirmed_at: string | null
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  let draftId: string
  let phase: ApplyPhase
  try {
    const body = await request.json()
    draftId = typeof body?.draftId === 'string' ? body.draftId : ''
    phase = body?.phase === 'submit' ? 'submit' : body?.phase === 'fill' ? 'fill' : ('' as ApplyPhase)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  if (!draftId || !phase) {
    return NextResponse.json({ error: 'draftId and phase are required' }, { status: 400, headers: NO_STORE })
  }

  const admin = createAdminClient()

  // Consume FIRST: a bundle is never composed for a caller that could not
  // present a live authorization, whatever else is true of the draft.
  const consumed = await consumePhaseToken(admin, { draftId, phase })
  if (!consumed) {
    return NextResponse.json(
      { error: 'No live authorization for this draft/phase.' },
      { status: 403, headers: NO_STORE }
    )
  }
  const reportToken = await mintReportToken(admin, { draftId, phase, consumedRowId: consumed.id })

  const { data: draft } = await admin
    .from('application_drafts')
    .select('id, user_id, job_id, status, resume_summary, cover_letter, fill_state, review_confirmed_at')
    .eq('id', draftId)
    .maybeSingle()
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404, headers: NO_STORE })
  const row = draft as DraftRow

  if (phase === 'submit') {
    if (row.status !== 'approved') {
      return NextResponse.json({ error: 'Draft is not approved.' }, { status: 403, headers: NO_STORE })
    }
    const confirmedAt = row.review_confirmed_at ? Date.parse(row.review_confirmed_at) : NaN
    if (!Number.isFinite(confirmedAt) || Date.now() - confirmedAt > AUTHORIZATION_MAX_AGE_MS) {
      return NextResponse.json(
        { error: 'Review confirmation is missing or stale — confirm again.' },
        { status: 403, headers: NO_STORE }
      )
    }
  }

  // Job DESCRIPTION is deliberately never fetched or released here — it is
  // employer-authored text, and this bundle's contents flow straight into
  // apply_fill.py's browser-use task prompt with no frameJobText/PROMPT_MARKER
  // framing (that TS-side mechanism has no Python-runtime equivalent this
  // repo boundary can reach — see invariant 3). Leaving the description out
  // entirely is the safer choice over half-wiring an unframed field a future
  // edit could plug straight into the prompt.
  const { data: job } = await admin.from('jobs').select('url').eq('id', row.job_id).maybeSingle()
  if (!job?.url) return NextResponse.json({ error: 'Job has no URL.' }, { status: 422, headers: NO_STORE })

  let credential: { username: string; secret: string } | null = null
  const host = normalizeHost(job.url)
  if (host) {
    try {
      const resolved = await resolveCredentialFor(admin, row.user_id, { host }, { markUsed: true })
      if (resolved) credential = { username: resolved.username, secret: resolved.secret }
    } catch (err) {
      // A vault refusal (no encryption, unreadable profile) must not fail
      // the whole bundle — assisted apply simply proceeds without a stored
      // sign-in, exactly like a user who never saved one.
      console.warn('[apply/bundle] credential resolution failed, proceeding without one', err)
    }
  }

  if (phase === 'fill') {
    const { data: profileRow } = await admin
      .from('profiles')
      .select('full_name, email, resume_text, preferences')
      .eq('id', row.user_id)
      .maybeSingle()
    const profile = buildApplyProfile({
      full_name: (profileRow?.full_name as string | null) ?? null,
      email: (profileRow?.email as string | null) ?? null,
      resume_text: (profileRow?.resume_text as string | null) ?? null,
      preferences: profileRow?.preferences,
    })

    let resumeText: string | null = null
    try {
      const tailored = await getLatestVersion(admin, row.user_id, row.job_id)
      const doc = tailored ?? (await getBaseResume(admin, row.user_id))
      resumeText = doc?.content?.trim() || null
    } catch (err) {
      console.warn('[apply/bundle] resume_documents lookup failed', err)
    }
    resumeText = resumeText || profile.resumeText?.trim() || row.resume_summary?.trim() || null

    return NextResponse.json(
      {
        phase: 'fill',
        draftId,
        jobUrl: job.url,
        profile,
        resumeText,
        coverLetter: row.cover_letter ?? null,
        credential,
        reportToken,
      },
      { headers: NO_STORE }
    )
  }

  return NextResponse.json(
    {
      phase: 'submit',
      draftId,
      jobUrl: job.url,
      answers: row.fill_state ?? null,
      credential,
      reportToken,
    },
    { headers: NO_STORE }
  )
}
