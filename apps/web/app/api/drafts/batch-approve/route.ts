// The morning review.
//
//   GET  /api/drafts/batch-approve  → the manifest: every pending application,
//        split into "safe to approve in one pass" and "needs you individually",
//        with enough on each row to judge it in seconds.
//   POST /api/drafts/batch-approve  → approve a confirmed batch, one resumable
//        round at a time.
//
// WHY A DEDICATED ROUTE RATHER THAN A LOOP OVER /api/drafts/approve
//   Three properties that only exist when one request owns the whole batch:
//
//   1. RE-VALIDATION. Every item is re-decided here, from rows read inside this
//      request, by the same decideBatchEligibility() the manifest used. A
//      client that unchecks a knock-out item and a client that lies about it
//      get identical treatment, because the client's opinion is never an input.
//
//   2. IDEMPOTENCE. Each item is CLAIMED with a conditional
//      pending_review → approved update before anything leaves the building.
//      Postgres re-evaluates that WHERE under row lock, so of two racing
//      requests exactly one claim matches and the other sees zero rows and
//      skips. A double-click, a retried round, or two tabs cannot apply twice.
//      The claim uses the existing `approved` status on purpose: a request that
//      dies mid-flight leaves a draft that the queue still renders correctly
//      and that can never be silently re-submitted, which a bespoke in-flight
//      status would not.
//
//   3. A BOUNDED, RESUMABLE RUN. A confirmed batch is capped
//      (BATCH_APPROVE_CAP) and executed in rounds, so the caller can show real
//      progress and stop it — see components/queue/batch-approve.tsx, which
//      drives this the way components/jobs/refresh-button.tsx drives the
//      resumable refresh route.
//
// HARD BOUNDARIES INHERITED, NOT RELAXED
//   Submission still goes through lib/ats-apply's submitApplication(), which is
//   official-API-only, credential-gated, and re-runs assessReadiness() itself.
//   Nothing here can turn a handoff into a POST. Batch approval is not
//   unattended: `confirmed: true` must be supplied by a human action in this
//   session, mirroring lib/harness/chains.ts#buildSubmitConfirmedPlan, and
//   autopilot's cron path does not call this route at all.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import {
  submitApplication,
  buildApplyProfile,
  buildHandoffFields,
  buildDraftAnswers,
  detectApplyTarget,
  resolveApplyCredentials,
  type ApplyContent,
  type ApplyCredentials,
  type ApplyProfile,
  type ApplyProviderId,
  type DraftAnswers,
  type SubmitApplicationParams,
  isSubmitAuthorization,
  AUTHORIZATION_MAX_AGE_MS,
  type SubmitAuthorization,
} from '@/lib/ats-apply'
import { parseMatchDetails, type MatchDetails } from '@/components/jobs/match-types'
import { logApiError } from '@/lib/observability/log'
import { unjudgedCvTailorDraftIds } from '@/lib/evals/verdicts'
import {
  BATCH_APPROVE_CAP,
  BATCH_ROUND_BUDGET_MS,
  BATCH_ROUND_SIZE,
  decideBatchEligibility,
  resolveApplyEmail,
  type BatchDecision,
} from './eligibility'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// --- Row shapes (application_drafts is untyped; same convention as /api/drafts)

interface CompanyRel {
  name?: string | null
  metadata?: unknown
}

interface JobRel {
  id: string
  title: string | null
  url: string | null
  description: string | null
  location: string | null
  match_score: number | null
  match_details: unknown
  companies?: CompanyRel | CompanyRel[] | null
}

interface DraftRowRaw {
  id: string
  job_id: string
  status: string
  resume_summary: string | null
  cover_letter: string | null
  answers: unknown
  created_at: string
  jobs?: JobRel | JobRel[] | null
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

const DRAFT_SELECT =
  'id, job_id, status, resume_summary, cover_letter, answers, created_at, ' +
  'jobs(id, title, url, description, location, match_score, match_details, companies(name, metadata))'

/** answers.deferredToHuman, defensively — the column is free-form jsonb. */
function storedDeferred(answers: unknown): string[] {
  if (!answers || typeof answers !== 'object') return []
  const value = (answers as Record<string, unknown>).deferredToHuman
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

// --- The manifest -----------------------------------------------------------

/** One prepared application, as the review surface needs to see it. Note that
 *  the job DESCRIPTION never appears here: it is scanned for knock-outs on the
 *  server and only the verdict is shipped. */
export interface ReviewItem {
  draftId: string
  jobId: string
  jobTitle: string
  jobUrl: string | null
  location: string | null
  companyName: string
  matchScore: number | null
  /** Why the matcher scored it that way, in its own words. */
  matchWhy: string | null
  matchHighlights: string[]
  matchGaps: string[]
  /** What the résumé was tailored toward for this specific role. */
  tailoredSummary: string | null
  hasCoverLetter: boolean
  knockouts: string[]
  batchable: boolean
  mode: BatchDecision['mode']
  provider: ApplyProviderId | null
  blockers: string[]
  createdAt: string
}

function matchWhyFrom(details: MatchDetails | null): string | null {
  if (!details) return null
  const summary = details.summary?.trim()
  if (summary) return summary
  const seniority = details.seniorityFit?.trim()
  if (seniority) return seniority
  const highlights = (details.highlights ?? []).filter(Boolean)
  return highlights.length > 0 ? highlights.slice(0, 2).join(' · ') : null
}

/** Trim the tailored summary to a scannable length — the review surface is for
 *  judging in seconds, and the full text is one click away on the draft card. */
function clip(text: string | null | undefined, max: number): string | null {
  const value = text?.trim()
  if (!value) return null
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
}

function buildReviewItem(draft: DraftRowRaw, decision: BatchDecision): ReviewItem {
  const job = one(draft.jobs)
  const company = one(job?.companies)
  const details = parseMatchDetails(job?.match_details as MatchDetails | string | null)
  return {
    draftId: draft.id,
    jobId: draft.job_id,
    jobTitle: job?.title?.trim() || 'Untitled role',
    jobUrl: job?.url ?? null,
    location: job?.location ?? null,
    companyName: company?.name?.trim() || 'Unknown company',
    matchScore: typeof job?.match_score === 'number' ? job.match_score : null,
    matchWhy: clip(matchWhyFrom(details), 220),
    matchHighlights: (details?.highlights ?? []).filter(Boolean).slice(0, 3),
    matchGaps: (details?.gaps ?? []).filter(Boolean).slice(0, 2),
    tailoredSummary: clip(draft.resume_summary, 220),
    hasCoverLetter: !!draft.cover_letter?.trim(),
    knockouts: decision.knockouts,
    batchable: decision.batchable,
    mode: decision.mode,
    provider: decision.provider,
    blockers: decision.blockers,
    createdAt: draft.created_at,
  }
}

/** Highest-scoring first, unscored last, newest first within a tie — the order
 *  a person reviewing 50 of these actually wants to read them in. */
function byWorthReadingFirst(a: ReviewItem, b: ReviewItem): number {
  const left = a.matchScore ?? -1
  const right = b.matchScore ?? -1
  if (left !== right) return right - left
  return b.createdAt.localeCompare(a.createdAt)
}

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('full_name, email, resume_text, preferences')
    .eq('id', user.id)
    .single()

  const accountEmail = ((profile?.email as string | null) ?? user.email ?? '').trim()
  const applyEmail = resolveApplyEmail(profile?.preferences, accountEmail)
  const applyProfile = applyProfileFor(profile, applyEmail.address)

  const { data, error } = await admin
    .from('application_drafts')
    .select(DRAFT_SELECT)
    .eq('user_id', user.id)
    .eq('status', 'pending_review')
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const drafts = (data ?? []) as unknown as DraftRowRaw[]
  const unjudged = await unjudgedCvTailorDraftIds(admin, user.id, drafts.map((d) => d.id))
  const items = drafts.map((draft) => {
    const job = one(draft.jobs)
    const company = one(job?.companies)
    const credentials = resolveApplyCredentials(company?.metadata, profile?.preferences)
    const decision = decideBatchEligibility({
      jobUrl: job?.url ?? null,
      jobDescription: job?.description ?? null,
      storedDeferred: storedDeferred(draft.answers),
      resumeSummary: draft.resume_summary,
      profile: applyProfile,
      hasCredential: hasCredentialFor(credentials, job?.url ?? null),
      requiresReview: unjudged.has(draft.id),
    })
    return buildReviewItem(draft, decision)
  })

  const batchable = items.filter((i) => i.batchable).sort(byWorthReadingFirst)
  const needsAttention = items.filter((i) => !i.batchable).sort(byWorthReadingFirst)

  return NextResponse.json({
    ok: true,
    cap: BATCH_APPROVE_CAP,
    applyEmail: applyEmail.address,
    applyEmailSource: applyEmail.source,
    applyEmailConfigured: applyEmail.configured,
    applyEmailInvalid: applyEmail.invalid,
    accountEmail,
    items: batchable,
    needsAttention,
    counts: {
      total: items.length,
      batchable: batchable.length,
      needsAttention: needsAttention.length,
      willSubmit: batchable.filter((i) => i.mode === 'submit').length,
      willHandoff: batchable.filter((i) => i.mode === 'handoff').length,
    },
  })
}

/** Build the identity we will actually send, with the apply email substituted
 *  for the account email. buildApplyProfile() reads profiles.email because that
 *  is the only address it knows about; the address a user APPLIES from is a
 *  separate, deliberate choice (see resolveApplyEmail). */
function applyProfileFor(
  profile: { full_name?: unknown; email?: unknown; resume_text?: unknown } | null | undefined,
  applyEmail: string
): ApplyProfile {
  const base = buildApplyProfile({
    full_name: (profile?.full_name as string | null) ?? null,
    email: (profile?.email as string | null) ?? null,
    resume_text: (profile?.resume_text as string | null) ?? null,
    preferences: (profile as { preferences?: unknown } | null | undefined)?.preferences,
  })
  return { ...base, email: applyEmail }
}

/** Does an apply credential exist for the provider THIS posting uses? A
 *  Greenhouse key does not make a Lever posting submittable, and passing a
 *  blanket "some credential exists" into the decision would advertise a direct
 *  submit in the confirmation that lib/ats-apply then turns into a handoff. */
function hasCredentialFor(credentials: ApplyCredentials, jobUrl: string | null): boolean {
  const provider = detectApplyTarget(jobUrl)?.provider ?? null
  return !!provider && !!credentials[provider]
}

// --- The batch --------------------------------------------------------------

export type ItemOutcome = 'submitted' | 'handoff' | 'failed' | 'blocked' | 'skipped'

export interface ItemResult {
  draftId: string
  companyName: string | null
  jobTitle: string | null
  outcome: ItemOutcome
  /** Why, for the outcomes that need a why. Shown per-item in the results list. */
  reason: string | null
  blockers?: string[]
  provider?: ApplyProviderId | null
  handoffUrl?: string | null
  submissionRef?: string | null
}

interface BatchBody {
  draftIds: string[]
  batchId: string
  /** ISO-8601 moment the human clicked through the confirmation. */
  confirmedAt: string
  cursor: number
}

/** Tolerance for a client clock running ahead of the server's. Anything beyond
 *  it is not skew, it is a confirmation dated into the future. */
const CLOCK_SKEW_MS = 5 * 60 * 1000

/** Parse + validate the payload. Returns a 4xx response instead of a body when
 *  the request must not run at all — an over-cap or unconfirmed request applies
 *  to ZERO employers rather than to the first N. */
function parseBody(raw: unknown): BatchBody | NextResponse {
  if (!raw || typeof raw !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const body = raw as Record<string, unknown>

  // The literal human gate, same shape as chains.ts#buildSubmitConfirmedPlan.
  // Truthy is not enough: only `true` means a person read the confirmation.
  if (body.confirmed !== true) {
    return NextResponse.json(
      { error: 'This batch was not confirmed. Nothing was submitted.' },
      { status: 400 }
    )
  }

  if (!Array.isArray(body.draftIds) || body.draftIds.length === 0) {
    return NextResponse.json({ error: 'draftIds must be a non-empty array' }, { status: 400 })
  }
  if (!body.draftIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    return NextResponse.json({ error: 'draftIds must all be strings' }, { status: 400 })
  }

  // Deduped BEFORE the cap so a payload padded with repeats cannot smuggle the
  // real count past it, and so the same draft is never attempted twice in one
  // run even before the claim would have caught it.
  const draftIds = [...new Set(body.draftIds.map((id) => (id as string).trim()))]
  if (draftIds.length > BATCH_APPROVE_CAP) {
    return NextResponse.json(
      {
        error:
          `A single batch is capped at ${BATCH_APPROVE_CAP} applications; ` +
          `this one asked for ${draftIds.length}. Nothing was submitted.`,
      },
      { status: 400 }
    )
  }

  const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : ''
  if (batchId.length < 8 || batchId.length > 128) {
    return NextResponse.json(
      { error: 'batchId is required (8-128 characters) so a retry cannot apply twice' },
      { status: 400 }
    )
  }

  // WHEN the human confirmed, not just that they did. lib/ats-apply/capability.ts
  // refuses an authorization older than AUTHORIZATION_MAX_AGE_MS, so a batch
  // payload captured today cannot be replayed next week into fresh submissions;
  // checking it here as well means the whole batch is refused up front rather
  // than each item failing its own gate one at a time.
  const confirmedAt = typeof body.confirmedAt === 'string' ? body.confirmedAt.trim() : ''
  const confirmedMs = Date.parse(confirmedAt)
  if (!confirmedAt || !Number.isFinite(confirmedMs)) {
    return NextResponse.json(
      { error: 'confirmedAt must be the ISO timestamp of the confirmation you clicked' },
      { status: 400 }
    )
  }
  const now = Date.now()
  if (confirmedMs > now + CLOCK_SKEW_MS) {
    return NextResponse.json({ error: 'confirmedAt is in the future' }, { status: 400 })
  }
  if (now - confirmedMs > AUTHORIZATION_MAX_AGE_MS) {
    return NextResponse.json(
      { error: 'That confirmation is more than 24 hours old. Review and confirm again.' },
      { status: 400 }
    )
  }

  const rawCursor = body.cursor
  const cursor = typeof rawCursor === 'number' && Number.isInteger(rawCursor) ? rawCursor : 0
  if (cursor < 0 || cursor > draftIds.length) {
    return NextResponse.json({ error: 'cursor is out of range' }, { status: 400 })
  }

  return { draftIds, batchId, confirmedAt, cursor }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseBody(raw)
  if (parsed instanceof NextResponse) return parsed
  const { draftIds, batchId, confirmedAt, cursor } = parsed

  const admin = createAdminClient()

  const { data: profile } = await admin
    .from('profiles')
    .select('full_name, email, resume_text, preferences')
    .eq('id', user.id)
    .single()

  const accountEmail = ((profile?.email as string | null) ?? user.email ?? '').trim()
  const applyEmail = resolveApplyEmail(profile?.preferences, accountEmail)

  // A configured-but-malformed apply address stops the whole batch. The
  // confirmation step told the user which address these applications would
  // carry; quietly substituting a different one would make that a lie, and the
  // address is on every application in the batch, not just one.
  if (applyEmail.invalid) {
    return NextResponse.json(
      {
        error:
          `The apply address in your settings (${applyEmail.configured}) is not a valid email ` +
          `address. Fix it before applying — nothing was submitted.`,
      },
      { status: 400 }
    )
  }

  const applyProfile = applyProfileFor(profile, applyEmail.address)

  const deadline = Date.now() + BATCH_ROUND_BUDGET_MS
  const results: ItemResult[] = []
  let index = cursor

  while (index < draftIds.length) {
    // Both bounds are checked BEFORE claiming an item, so a round never claims
    // work it then abandons — the caller resumes from `index` and the set of
    // attempted items stays a contiguous prefix of draftIds.
    if (results.length >= BATCH_ROUND_SIZE) break
    if (results.length > 0 && Date.now() >= deadline) break

    results.push(
      await approveOne({
        admin,
        userId: user.id,
        draftId: draftIds[index],
        batchId,
        confirmedAt,
        applyProfile,
        preferences: profile?.preferences,
      })
    )
    index++
  }

  const done = index >= draftIds.length
  return NextResponse.json({
    ok: true,
    batchId,
    results,
    processed: results.length,
    cursor: done ? null : index,
    total: draftIds.length,
    done,
    totals: {
      submitted: results.filter((r) => r.outcome === 'submitted').length,
      handoff: results.filter((r) => r.outcome === 'handoff').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
      blocked: results.filter((r) => r.outcome === 'blocked').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
    },
  })
}

interface ApproveOneParams {
  admin: ReturnType<typeof createAdminClient>
  userId: string
  draftId: string
  batchId: string
  confirmedAt: string
  applyProfile: ApplyProfile
  preferences: unknown
}

/**
 * The human confirmation, in the shape the submission engine demands.
 *
 * Scoped to ONE job on purpose. `jobIds` is what stops an approval for job A
 * from authorizing job B (lib/ats-apply/capability.ts refuses an
 * authorization-job-mismatch), so handing the engine the whole batch's job list
 * would hand every item an approval broad enough to cover every other item —
 * turning a per-application gate back into a blanket one.
 */
function authorizationFor(jobId: string, batchId: string, confirmedAt: string): SubmitAuthorization {
  return {
    confirmed: true,
    source: 'human-approval-route',
    at: confirmedAt,
    jobIds: [jobId],
    batchId,
  }
}

/**
 * Approve exactly one prepared application.
 *
 * Total by construction: every failure path becomes an ItemResult, never a
 * throw. A rejection here would abandon this index while later ones completed,
 * and the caller's cursor would then skip an application silently — the same
 * prefix property lib/graph/refresh.ts documents at length (this route's own
 * cursor, not that file's graph-thread one, but the identical hazard).
 */
async function approveOne(params: ApproveOneParams): Promise<ItemResult> {
  const { admin, userId, draftId, batchId, confirmedAt, applyProfile, preferences } = params
  const base: ItemResult = {
    draftId,
    companyName: null,
    jobTitle: null,
    outcome: 'skipped',
    reason: null,
  }

  try {
    // 1) Load the draft, scoped to this user. An id the caller invented, or one
    //    belonging to somebody else, simply is not found.
    const { data, error } = await admin
      .from('application_drafts')
      .select(DRAFT_SELECT)
      .eq('id', draftId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return { ...base, outcome: 'failed', reason: error.message }
    if (!data) return { ...base, reason: 'No such application in your queue.' }

    const draft = data as unknown as DraftRowRaw
    const job = one(draft.jobs)
    const company = one(job?.companies)
    const companyName = company?.name?.trim() || null
    const jobTitle = job?.title?.trim() || null
    const named: ItemResult = { ...base, companyName, jobTitle }

    // 2) Idempotence, part one: anything already acted on is a no-op. This is
    //    what makes a resent round harmless, and it is durable — it survives a
    //    reload, a second tab and a redeploy, which an in-memory guard would not.
    if (draft.status !== 'pending_review') {
      return {
        ...named,
        reason:
          draft.status === 'submitted'
            ? 'Already submitted — not sent again.'
            : `Already ${draft.status} — left alone.`,
      }
    }

    if (!job) return { ...named, outcome: 'failed', reason: 'The role for this draft is missing.' }

    // 3) Idempotence, part two: dedupe against the pipeline. A role the user
    //    already applied to — by hand, or through an earlier batch — is skipped
    //    even if a stale draft for it is still sitting in the queue.
    const { data: existingApp } = await admin
      .from('applications')
      .select('id, applied_at')
      .eq('user_id', userId)
      .eq('job_id', draft.job_id)
      .maybeSingle()
    if (existingApp?.applied_at) {
      return { ...named, reason: 'You have already applied to this role.' }
    }

    // 4) THE RE-VALIDATION. Recomputed here from the rows just read, with the
    //    identity that will actually be sent — not from anything the client
    //    said. An item the client should not have offered is refused here, and
    //    refused WITHOUT touching the row, so it stays in the queue for the
    //    individual attention it needs.
    const credentials = resolveApplyCredentials(company?.metadata, preferences)
    const unjudged = await unjudgedCvTailorDraftIds(admin, userId, [draftId])
    const decision = decideBatchEligibility({
      jobUrl: job.url,
      jobDescription: job.description,
      storedDeferred: storedDeferred(draft.answers),
      resumeSummary: draft.resume_summary,
      profile: applyProfile,
      hasCredential: hasCredentialFor(credentials, job.url),
      requiresReview: unjudged.has(draftId),
    })
    if (!decision.batchable) {
      return {
        ...named,
        outcome: 'blocked',
        reason: decision.blockers[0] ?? 'Needs your individual attention.',
        blockers: decision.blockers,
      }
    }

    // 5) CLAIM. pending_review → approved, conditional on it still being
    //    pending_review. Postgres re-evaluates that predicate under the row
    //    lock, so of two racing requests exactly one gets a row back; the loser
    //    sees zero and stops here, before any submission is attempted.
    const claimedAt = new Date().toISOString()
    const authorization = authorizationFor(job.id, batchId, confirmedAt)
    // Belt to the engine's braces: if this route ever built a malformed
    // authorization, refuse here rather than send an application whose approval
    // cannot be evidenced afterwards.
    if (!isSubmitAuthorization(authorization)) {
      return {
        ...named,
        outcome: 'failed',
        reason: 'Could not record your confirmation for this application, so nothing was sent.',
      }
    }
    const claimAnswers = {
      ...((draft.answers as Record<string, unknown> | null) ?? {}),
      batch: { id: batchId, at: claimedAt },
      authorization,
    }
    const { data: claimed, error: claimErr } = await admin
      .from('application_drafts')
      .update({ status: 'approved', answers: claimAnswers, reviewed_at: claimedAt, updated_at: claimedAt })
      .eq('id', draftId)
      .eq('user_id', userId)
      .eq('status', 'pending_review')
      .select('id')
    if (claimErr) return { ...named, outcome: 'failed', reason: claimErr.message }
    if (!claimed || claimed.length !== 1) {
      return { ...named, reason: 'Already being applied to in another run.' }
    }

    // 6) Submit. submitApplication() is the same entry point the single-draft
    //    approve route uses and enforces the same boundaries — official APIs
    //    only, credential-gated, knock-outs re-checked on its own terms. Even a
    //    payload that somehow got past step 4 cannot become a blind POST here.
    const jobUrl = job.url ?? ''
    const content: ApplyContent = {
      resumeSummary: draft.resume_summary ?? undefined,
      coverLetter: draft.cover_letter ?? undefined,
    }
    // Typed as an intersection rather than passed as a fresh object literal on
    // purpose. `authorization` is the parameter lib/ats-apply/capability.ts was
    // built to read (its `missing-human-authorization` blocker is the first
    // thing it checks), and SubmitApplicationParams is gaining the field as that
    // work lands — see needsOtherFiles. Widening here means this route forwards
    // the confirmation on the day the engine starts reading it, without pinning
    // the route to a half-landed signature in the meantime. It is inert, never
    // wrong: an engine that ignores the field behaves exactly as before.
    const submitParams: SubmitApplicationParams & { authorization: SubmitAuthorization } = {
      jobUrl,
      profile: applyProfile,
      content,
      jobDescription: job.description,
      credentials,
      client: admin,
      userId,
      jobId: job.id,
      authorization,
    }
    const result = await submitApplication(submitParams)

    const provider = result.provider
    const fields =
      result.outcome === 'handoff'
        ? result.fields
        : buildHandoffFields(provider ?? 'greenhouse', applyProfile, content)
    const answers: DraftAnswers = buildDraftAnswers(provider, jobUrl, fields, result, job.description)
    // Carried forward so the claim survives the final write — otherwise a
    // resent round could not tell which batch had already handled this row.
    answers.batch = { id: batchId, at: claimedAt }
    answers.authorization = authorization
    // Append, never replace: DraftAnswers.attempts is the evidence a user needs
    // to prove what left their name and on whose say-so, and an earlier attempt
    // on this draft is as much a part of that record as this one.
    const attempt = result.attempt
    if (attempt) {
      const prior = Array.isArray(draft.answers && (draft.answers as DraftAnswers).attempts)
        ? ((draft.answers as DraftAnswers).attempts ?? [])
        : []
      answers.attempts = [...prior, attempt]
    }
    if (result.outcome === 'failed') {
      answers.submitError = result.error
      logApiError('drafts/batch-approve:submit', new Error(result.error), {
        userId,
        jobId: job.id,
        draftId,
        provider,
        batchId,
      })
    }

    const status =
      result.outcome === 'submitted' ? 'submitted' : result.outcome === 'failed' ? 'failed' : 'approved'
    const now = new Date().toISOString()
    const { error: updErr } = await admin
      .from('application_drafts')
      .update({
        status,
        answers,
        submission_ref: result.outcome === 'submitted' ? result.submissionRef : null,
        submitted_at: status === 'submitted' ? now : null,
        updated_at: now,
      })
      .eq('id', draftId)
      .eq('user_id', userId)
    if (updErr) {
      // The submission itself may well have succeeded; say so rather than
      // reporting a clean failure the user would reasonably retry.
      return {
        ...named,
        outcome: 'failed',
        reason: `Applied, but the result could not be saved: ${updErr.message}`,
        provider,
      }
    }

    if (result.outcome === 'submitted') {
      await reflectInPipeline(admin, userId, draft, existingApp?.id ?? null)
      return {
        ...named,
        outcome: 'submitted',
        reason: `Submitted via ${provider ?? 'ATS'}.`,
        provider,
        submissionRef: result.submissionRef,
      }
    }
    if (result.outcome === 'handoff') {
      return {
        ...named,
        outcome: 'handoff',
        reason: 'Prefilled link ready — open it to finish.',
        provider,
        handoffUrl: result.prefilledUrl,
      }
    }
    return { ...named, outcome: 'failed', reason: result.error, provider }
  } catch (err) {
    // See this function's doc comment: it must not throw.
    return {
      ...base,
      outcome: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Mirror a real submission into the pipeline. Best-effort and deduped: a
 *  missing applications row must never turn a completed submission into a
 *  reported failure the user would retry. */
async function reflectInPipeline(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  draft: DraftRowRaw,
  existingApplicationId: string | null
): Promise<void> {
  try {
    const now = new Date().toISOString()
    if (existingApplicationId) {
      await admin
        .from('applications')
        .update({ stage: 'applied', applied_at: now, updated_at: now })
        .eq('id', existingApplicationId)
        .eq('user_id', userId)
      return
    }
    await admin.from('applications').insert({
      user_id: userId,
      job_id: draft.job_id,
      stage: 'applied',
      applied_at: now,
      source: 'cello-batch-approve',
      cover_letter: draft.cover_letter ?? null,
    })
  } catch {
    /* pipeline reflection is best-effort */
  }
}
