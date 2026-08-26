// PATCH /api/apply/state — the browser-runner's callback reporting what
// happened during a fill or submit run.
//
// Auth is TWO factors: BROWSER_RUNNER_SECRET (the same transport-level
// identity app/api/apply/bundle requires), PLUS a `reportToken` that must
// match the one mintReportToken() handed back in THAT bundle's response
// body (verifyReportToken(), lib/ats-apply/phase-tokens.ts). This is not a
// second release of anything sensitive — the phase token itself was already
// consumed when the bundle was fetched — but it IS what stops a caller who
// holds only BROWSER_RUNNER_SECRET plus a (draftId, phase) pair (both
// visible in a GitHub Actions run's own logs/UI) from reporting an outcome
// for a run that never actually fetched a bundle at all: without this
// check, a forged callback could write a fabricated 'submitted' result and
// receipt for any draft sitting in 'approved', with prepare/bundle/confirm
// never having been called. Each branch is additionally gated on the draft
// already being in the state that phase implies (filling / approved), so a
// stray or replayed callback cannot move a draft through the state machine
// out of order.
//
// STATE MACHINE THIS ROUTE DRIVES:
//   fill:   filling -> pending_review (fill_state + screenshots recorded)
//   submit: approved -> submitted             (result: 'submitted')
//           approved -> pending_review        (result: 'deviation' — the
//                                               live form changed since
//                                               review; apply_submit.py
//                                               aborts rather than guess)
//           approved -> failed                (result: 'failed')
//
// RECEIPT HONESTY (ruling per docs/superpowers/specs/...#browser-use
// assisted apply): a submitted outcome writes an application_receipts row
// with provenance='browser_companion' and verification_state
// 'system_confirmed' ONLY when the runner explicitly witnessed a
// confirmation (body.confirmed === true) — anything else is 'unconfirmed'.
// These are never conflated; see lib/applications/types.ts.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { verifyReportToken } from '@/lib/ats-apply/phase-tokens'
import { createReceipt } from '@/lib/applications/store'
import { DATA_URL_RE, MAX_ATTACHMENT_BYTES, base64ByteSize } from '@/lib/applications/receipts'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const MAX_SCREENSHOTS = 12

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.BROWSER_RUNNER_SECRET
  if (!secret) return false
  const auth = request.headers.get('authorization')
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
  return bearer === secret
}

interface ScreenshotIn {
  page: string
  dataUrl: string
  capturedAt: string
}

function validateScreenshots(raw: unknown): { ok: true; value: ScreenshotIn[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'screenshots must be an array' }
  if (raw.length > MAX_SCREENSHOTS) return { ok: false, error: `no more than ${MAX_SCREENSHOTS} screenshots` }
  const out: ScreenshotIn[] = []
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const page = typeof o.page === 'string' ? o.page.trim() : ''
    const dataUrl = typeof o.dataUrl === 'string' ? o.dataUrl : ''
    const capturedAt = typeof o.capturedAt === 'string' && Number.isFinite(Date.parse(o.capturedAt))
      ? o.capturedAt
      : new Date().toISOString()
    if (!page) return { ok: false, error: 'each screenshot needs a page label' }
    const match = DATA_URL_RE.exec(dataUrl)
    if (!match) return { ok: false, error: `screenshot "${page}" is not a PNG/JPEG/GIF/WEBP data URL` }
    if (base64ByteSize(match[2]) > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `screenshot "${page}" is too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)` }
    }
    out.push({ page, dataUrl, capturedAt })
  }
  return { ok: true, value: out }
}

export async function PATCH(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) ?? {}
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  const draftId = typeof body.draftId === 'string' ? body.draftId : ''
  const phase = body.phase === 'submit' ? 'submit' : body.phase === 'fill' ? 'fill' : ''
  const reportToken = typeof body.reportToken === 'string' ? body.reportToken : ''
  if (!draftId || !phase) {
    return NextResponse.json({ error: 'draftId and phase are required' }, { status: 400, headers: NO_STORE })
  }

  const admin = createAdminClient()

  // Proves this callback corresponds to a run that actually fetched a
  // bundle for this exact (draft, phase) — see the file header.
  const tokenOk = await verifyReportToken(admin, { draftId, phase, reportToken })
  if (!tokenOk) {
    return NextResponse.json(
      { error: 'No matching report token for this draft/phase — refusing an unverified callback.' },
      { status: 403, headers: NO_STORE }
    )
  }

  const { data: draft } = await admin
    .from('application_drafts')
    .select('id, user_id, job_id, status, fill_state')
    .eq('id', draftId)
    .maybeSingle()
  if (!draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404, headers: NO_STORE })

  const nowIso = new Date().toISOString()

  if (phase === 'fill') {
    if (draft.status !== 'filling') {
      return NextResponse.json(
        { error: `Draft is ${draft.status}, not filling — ignoring stale/replayed callback.` },
        { status: 409, headers: NO_STORE }
      )
    }
    const fillState = body.fillState
    if (fillState !== undefined && (typeof fillState !== 'object' || fillState === null || Array.isArray(fillState))) {
      return NextResponse.json({ error: 'fillState must be an object' }, { status: 400, headers: NO_STORE })
    }
    const screenshots = validateScreenshots(body.screenshots)
    if (!screenshots.ok) return NextResponse.json({ error: screenshots.error }, { status: 400, headers: NO_STORE })

    const { error } = await admin
      .from('application_drafts')
      .update({
        status: 'pending_review',
        fill_state: fillState ?? {},
        screenshots: screenshots.value,
        updated_at: nowIso,
      })
      .eq('id', draftId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE })
    return NextResponse.json({ ok: true, status: 'pending_review' }, { headers: NO_STORE })
  }

  // phase === 'submit'
  if (draft.status !== 'approved') {
    return NextResponse.json(
      { error: `Draft is ${draft.status}, not approved — ignoring stale/replayed callback.` },
      { status: 409, headers: NO_STORE }
    )
  }

  const result = body.result === 'submitted' || body.result === 'deviation' || body.result === 'failed'
    ? body.result
    : null
  if (!result) {
    return NextResponse.json(
      { error: "result must be 'submitted' | 'deviation' | 'failed'" },
      { status: 400, headers: NO_STORE }
    )
  }

  if (result === 'deviation') {
    const detail = typeof body.deviationDetail === 'string' ? body.deviationDetail.slice(0, 2000) : 'The live form changed since review.'
    const priorFillState = (draft.fill_state && typeof draft.fill_state === 'object') ? draft.fill_state : {}
    const { error } = await admin
      .from('application_drafts')
      .update({
        status: 'pending_review',
        fill_state: { ...priorFillState, deviation: { detail, at: nowIso } },
        updated_at: nowIso,
      })
      .eq('id', draftId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE })
    return NextResponse.json({ ok: true, status: 'pending_review' }, { headers: NO_STORE })
  }

  if (result === 'failed') {
    const detail = typeof body.error === 'string' ? body.error.slice(0, 2000) : 'Submit run failed.'
    const priorFillState = (draft.fill_state && typeof draft.fill_state === 'object') ? draft.fill_state : {}
    const { error } = await admin
      .from('application_drafts')
      .update({
        status: 'failed',
        fill_state: { ...priorFillState, submitError: { detail, at: nowIso } },
        updated_at: nowIso,
      })
      .eq('id', draftId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE })
    return NextResponse.json({ ok: true, status: 'failed' }, { headers: NO_STORE })
  }

  // result === 'submitted'
  const confirmationIdentifier = typeof body.confirmationIdentifier === 'string' ? body.confirmationIdentifier.slice(0, 200) : null
  const confirmationNote = typeof body.confirmationNote === 'string' ? body.confirmationNote.slice(0, 4000) : null
  // Never inferred from confirmationIdentifier presence — the runner says
  // explicitly whether it witnessed a real confirmation page/message.
  const confirmed = body.confirmed === true

  const { data: existingApp } = await admin
    .from('applications')
    .select('id')
    .eq('user_id', draft.user_id)
    .eq('job_id', draft.job_id)
    .maybeSingle()

  let ownedApplicationId: string | null = (existingApp?.id as string | undefined) ?? null
  if (!ownedApplicationId) {
    const { data: created, error: createErr } = await admin
      .from('applications')
      .insert({
        user_id: draft.user_id,
        job_id: draft.job_id,
        stage: 'applied',
        applied_at: nowIso,
        source: 'cello-assisted-apply',
      })
      .select('id')
      .single()
    if (createErr || !created) {
      return NextResponse.json(
        { error: createErr?.message ?? 'Could not create the applications row' },
        { status: 500, headers: NO_STORE }
      )
    }
    ownedApplicationId = created.id as string
  }

  try {
    await createReceipt(
      admin,
      draft.user_id,
      {
        applicationId: ownedApplicationId,
        submittedAt: nowIso,
        destination: 'Applied via Cello assisted apply (browser)',
        documents: [{ kind: 'resume', label: 'Resume', resumeDocumentId: null }],
        confirmationIdentifier,
        confirmationNote,
        confirmationAttachmentUrl: null,
      },
      'browser_companion',
      confirmed ? 'system_confirmed' : 'unconfirmed',
      { id: ownedApplicationId, user_id: draft.user_id, job_id: draft.job_id, stage: 'applied', applied_at: nowIso, source: 'cello-assisted-apply' }
    )
  } catch (err) {
    console.error('[apply/state] createReceipt failed', err)
    return NextResponse.json({ error: 'Submitted, but could not record a receipt.' }, { status: 500, headers: NO_STORE })
  }

  const { error: updErr } = await admin
    .from('application_drafts')
    .update({
      status: 'submitted',
      submission_ref: confirmationIdentifier,
      submitted_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', draftId)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500, headers: NO_STORE })

  return NextResponse.json({ ok: true, status: 'submitted' }, { headers: NO_STORE })
}
