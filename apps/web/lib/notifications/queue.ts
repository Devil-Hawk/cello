// The review queue's WHY — turning one application_drafts row into the reason
// a human has to look at it.
//
// WHY THIS FILE EXISTS
//   lib/harness/agents/applier.ts's default path (autoSubmit:false — which is
//   EVERY autopilot tick, per its own header) builds a handoff draft through a
//   local prepareHandoff() that never runs the capability assessment, so the
//   reason it stores on the draft is the same generic sentence for every
//   single item: "Prepared for review — approve to submit or open the
//   prefilled form." That is a status, not a WHY, and it is exactly the kind
//   of silent stall app/(app)/queue/page.tsx's header is trying to close: the
//   human sees a pile of cards but not which ones are blocked on something
//   only they can answer versus which ones are one click from going out.
//
//   decideBatchEligibility() (app/api/drafts/batch-approve/eligibility.ts)
//   already computes the real answer — knock-out questions, incomplete
//   identity, an unroutable posting — freshly, from the live job description
//   and profile, every time it's called. This module reuses that SAME pure
//   function (never re-derives its own copy of the rules) so the reason shown
//   in the notification bell, the /queue page and the morning batch review
//   can never disagree about why one draft needs a person.
//
// NOT AN AUTHORIZATION SURFACE
//   Nothing here decides whether anything may submit — that gate lives in
//   lib/ats-apply/capability.ts and is re-enforced server-side by every route
//   that actually writes. This module only explains, in one sentence, why a
//   row that is already sitting in pending_review is sitting there.

import {
  buildApplyProfile,
  detectApplyTarget,
  resolveApplyCredentials,
  type ApplyCredentials,
} from '@/lib/ats-apply'
import { decideBatchEligibility, type BatchDecision } from '@/app/api/drafts/batch-approve/eligibility'

/** The minimal profile row shape buildApplyProfile() needs — mirrors the
 *  `profiles` columns every other apply surface (applier.ts, the approve
 *  routes) already selects. */
export interface QueueProfileRow {
  full_name: string | null
  email: string | null
  resume_text: string | null
  preferences: unknown
}

/** One application_drafts row, joined down to what a reason needs to know.
 *  `job` is null when the join failed to resolve (deleted job row) — callers
 *  still get a reason, just a generic one, rather than throwing. */
export interface QueueDraftRow {
  id: string
  jobId: string
  resumeSummary: string | null
  answers: unknown
  createdAt: string
  job: {
    title: string | null
    url: string | null
    description: string | null
    location: string | null
    companyName: string | null
    companyMetadata: unknown
  } | null
}

/** One row for the review-queue surfaces (notification bell bucket + the
 *  /queue page's unmissable list). */
export interface ReviewQueueItem {
  draftId: string
  jobId: string
  title: string
  companyName: string
  location: string | null
  jobUrl: string | null
  /** The single sentence answering "why does this need me?". */
  reason: string
  /** What approving it would do, per decideBatchEligibility's ceiling rule —
   *  see that file's BatchDecision.mode doc for why this over-counts rather
   *  than under-counts. */
  mode: BatchDecision['mode']
  createdAt: string
  /**
   * The draft's most recent judge verdict (eval_verdicts, subject_kind=
   * 'cv_tailor_draft'), collapsed to the three-way chip the queue UI shows —
   * 'unjudged' covers every refusal outcome (insufficient-data/insufficient-
   * budget/unjudged/error), never a substituted score (invariant 7). Absent
   * when this draft has no verdict row at all yet (distinct from 'unjudged':
   * "never judged" vs "judged, and here is why we couldn't score it" — see
   * the eval_verdicts migration's own header). Looked up by the ROUTE, not
   * here — this function stays pure (see its own doc).
   */
  verdict?: 'pass' | 'fail' | 'unjudged'
}

/** application_drafts.answers.deferredToHuman, defensively — the column is
 *  free-form jsonb. Same extraction batch-approve/route.ts uses, duplicated
 *  here (rather than imported) because that copy is a private, unexported
 *  function of that route module. */
function storedDeferred(answers: unknown): string[] {
  if (!answers || typeof answers !== 'object') return []
  const value = (answers as Record<string, unknown>).deferredToHuman
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** Does an apply credential exist for the provider THIS posting uses? Mirrors
 *  batch-approve/route.ts#hasCredentialFor for the same reason: a Greenhouse
 *  key does not make a Lever posting submittable. */
function hasCredentialFor(credentials: ApplyCredentials, jobUrl: string | null): boolean {
  const provider = detectApplyTarget(jobUrl)?.provider ?? null
  return !!provider && !!credentials[provider]
}

/**
 * Turn a decision + credential state into the one sentence a human reads.
 *
 * Ordered by specificity: a real blocker (knock-out, missing identity,
 * unroutable posting) is always the most useful thing to say, because it is
 * the thing that keeps this item OUT of the batch-approvable list too. When
 * there is no blocker, the only reason left is the structural one every
 * candidate hits — no employer ever hands a job-seeker their own ATS
 * credential (see eligibility.ts's header) — so "no credential" is the
 * default reason, not an edge case.
 */
export function summarizeQueueReason(
  decision: Pick<BatchDecision, 'blockers' | 'mode'>,
  hasCredential: boolean
): string {
  if (decision.blockers.length > 0) return decision.blockers[0]
  if (decision.mode === 'submit') {
    return 'Ready to submit — approve to send it to the employer.'
  }
  return hasCredential
    ? 'Ready — opens as a prefilled link for you to finish.'
    : 'No employer apply credential on file — opens as a prefilled link for you to finish.'
}

/** Build one ReviewQueueItem from a draft row + the owner's profile. Pure
 *  aside from the eligibility re-scan, which is itself pure (no DB, no
 *  network) — safe to call for every row in a list without paying for it. */
export function buildQueueItem(draft: QueueDraftRow, profile: QueueProfileRow): ReviewQueueItem {
  const job = draft.job
  const applyProfile = buildApplyProfile(profile)
  const credentials = resolveApplyCredentials(job?.companyMetadata, profile.preferences)
  const hasCredential = hasCredentialFor(credentials, job?.url ?? null)

  const decision = decideBatchEligibility({
    jobUrl: job?.url ?? null,
    jobDescription: job?.description ?? null,
    storedDeferred: storedDeferred(draft.answers),
    resumeSummary: draft.resumeSummary,
    profile: applyProfile,
    hasCredential,
    // This function is pure by design (see its own doc comment) — no
    // eval_verdicts read here. `false` only affects this NOTIFICATION
    // summary's wording; the real "never auto-advances" gate is enforced
    // where it matters, in app/api/drafts/batch-approve/route.ts, which
    // reads the real unjudgedCvTailorDraftIds() set before deciding.
    requiresReview: false,
  })

  return {
    draftId: draft.id,
    jobId: draft.jobId,
    title: job?.title?.trim() || 'Untitled role',
    companyName: job?.companyName?.trim() || 'Unknown company',
    location: job?.location ?? null,
    jobUrl: job?.url ?? null,
    reason: summarizeQueueReason(decision, hasCredential),
    mode: decision.mode,
    createdAt: draft.createdAt,
  }
}

/** Collapses an eval_verdicts.verdict value to the queue UI's three-way
 *  chip — refuse-over-guess (invariant 7) means every refusal outcome
 *  (insufficient-data/insufficient-budget/unjudged/error) reads as
 *  'unjudged', never as a pass or a substituted score. */
export function toQueueVerdict(raw: string): ReviewQueueItem['verdict'] {
  if (raw === 'pass') return 'pass'
  if (raw === 'fail') return 'fail'
  return 'unjudged'
}
