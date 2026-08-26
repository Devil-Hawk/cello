// Server-side re-validation for the morning batch review.
//
// WHY THIS IS A SEPARATE MODULE
//   The review UI decides what to SHOW as approvable; the POST route decides
//   what actually happens. If those two answers came from different code, a
//   client-side exclusion would be the only thing standing between a knock-out
//   question and an application that answers it wrong — and a client-side
//   exclusion is not a safety property. They are the same function here, and
//   the server's copy governs: POST re-runs it for EVERY item against the rows
//   it just read from the database, and ignores whatever the client believed.
//
// WHAT "BATCHABLE" MEANS, AND WHAT IT DELIBERATELY DOES NOT MEAN
//   Approving in bulk is not submitting in bulk. lib/ats-apply attempts an
//   official submit only when an employer credential is configured for that
//   provider; absent one — the common case, and the ONLY case for a candidate,
//   since Greenhouse/Lever/Ashby submission keys belong to the employer — it
//   prepares a prefilled handoff link instead. Both are legitimate outcomes of
//   "I approve this application", so gating the batch on
//   assessReadiness().ready would make it approve nothing at all, for anyone.
//   That is why `hasCredential` decides the MODE, never the eligibility.
//
//   What does disqualify an item is exactly the set where a wrong answer costs
//   the user the role or misstates their status to an employer: knock-out
//   questions (visa / work authorisation / clearance / salary / demographic),
//   an incomplete identity, or a posting we cannot route to an official form.
//   Those are surfaced for individual attention, never batched.

import { detectApplyTarget } from '@/lib/ats-apply/detect'
import { assessReadiness, scanKnockouts } from '@/lib/ats-apply/readiness'
import type { ApplyProfile, ApplyProviderId } from '@/lib/ats-apply/types'

/**
 * The most applications one confirmed batch may touch.
 *
 * The number is the shape of the problem, not a round guess: autopilot runs
 * hourly overnight and a heavy night produces roughly this many pending
 * drafts, which is the pile the morning review exists to clear in one pass.
 * Anything materially larger is not a morning review — it is a runaway, or a
 * tampered payload — and the correct response to either is to refuse the whole
 * call rather than to start sending. Enforced in the route before any item is
 * touched, so an over-cap request submits zero applications, not fifty.
 */
export const BATCH_APPROVE_CAP = 50

/**
 * How many items one HTTP round may attempt. Each item can make an external
 * POST to an employer's ATS on top of several database round-trips, against a
 * 60s function limit — so the batch is driven to completion over several
 * rounds (see components/queue/batch-approve.tsx, which loops exactly the way
 * components/jobs/refresh-button.tsx drives the resumable refresh route).
 */
export const BATCH_ROUND_SIZE = 10

/** Wall-clock budget for one round; whichever of this and BATCH_ROUND_SIZE
 *  hits first ends the round. Well inside the route's 60s maxDuration. */
export const BATCH_ROUND_BUDGET_MS = 40_000

/** Same shape readiness.ts accepts. Kept here so callers pass rows, not prose. */
export interface BatchCandidate {
  /** jobs.url — the posting we would apply through. */
  jobUrl: string | null
  /** jobs.description — re-scanned for knock-outs on every call. */
  jobDescription: string | null
  /** application_drafts.answers.deferredToHuman, from the preparing run. */
  storedDeferred: string[]
  /** application_drafts.resume_summary. */
  resumeSummary: string | null
  /** Identity as it will actually be sent, including the apply email. */
  profile: ApplyProfile
  /** Whether an employer apply credential exists for the detected provider. */
  hasCredential: boolean
  /**
   * True when this draft's cv_tailor content carries an 'unjudged'
   * eval_verdicts row (lib/graph/verify/cv-tailor.ts: the factual-grounding
   * judge could not run — no key, or the budget cap refused it). Ruling 2c
   * (langgraph port design doc, Step 4): an unjudged draft REQUIRES human
   * review and must never auto-advance — a judge-FAILED draft never reaches
   * this check at all, since prepareApplicationDraft already persists it as
   * status 'failed', which the batch manifest's own `.eq('status',
   * 'pending_review')` query excludes before eligibility is ever computed.
   */
  requiresReview: boolean
}

export interface BatchDecision {
  /** May this be approved as part of a batch, without individual attention? */
  batchable: boolean
  /**
   * What approving it could do — a CEILING, never an under-count.
   *
   * This matters more than it looks. The confirmation step asks a person to
   * consent to N irreversible submissions, so N has to be the MOST that can
   * happen, not the most likely. lib/ats-apply/capability.ts applies a strictly
   * tighter gate than assessReadiness() does (it additionally demands a posting
   * id, a current human authorization, and — for Greenhouse — a readable form
   * schema proving every required question is answerable), so
   * `route === 'official-api'` implies `readiness.ready` but not the reverse.
   * Using readiness here therefore over-counts rather than under-counts: an
   * item shown as "submits directly" may still arrive at the employer as a
   * handoff, and the user consented to the larger thing. The reverse — telling
   * someone nothing would be sent and then sending it — is the failure this
   * asymmetry exists to make impossible.
   */
  mode: 'submit' | 'handoff'
  provider: ApplyProviderId | null
  /** Knock-out categories found — the reason a human must handle this one. */
  knockouts: string[]
  /** Plain-language reasons this cannot be batched. Empty iff batchable. */
  blockers: string[]
}

/**
 * readiness.ts reports its identity gaps as prose, and decides internally
 * which of them are disqualifying via the same two prefixes. Mirroring the
 * predicate keeps one definition of "the profile is too incomplete to send"
 * instead of two that can drift — but it is a string match on another module's
 * messages, which is why the batch route asks for a structured issue code in
 * its needsOtherFiles. Until then: if readiness.ts rewords an issue, this must
 * be updated with it, and the route's tests fail loudly if it is not.
 */
function isIdentityGap(issue: string): boolean {
  return issue.startsWith('Missing') || issue.startsWith('No resume')
}

/**
 * Decide whether one prepared application is safe to approve in bulk.
 *
 * Pure — no database, no network — so both the manifest (GET) and the
 * authoritative re-validation (POST) can call it with the same inputs and get
 * the same answer, and so the safety rules can be tested directly.
 */
export function decideBatchEligibility(candidate: BatchCandidate): BatchDecision {
  const blockers: string[] = []

  // NEVER AUTO-ADVANCES (ruling 2c): checked first and unconditionally, same
  // treatment as a knock-out — an unjudged draft is disqualified from the
  // batch regardless of what the rest of this function would otherwise decide.
  if (candidate.requiresReview) {
    blockers.push('An automated factual-grounding check could not run for this draft — review it individually.')
  }

  const jobUrl = candidate.jobUrl?.trim() ?? ''
  const target = jobUrl ? detectApplyTarget(jobUrl) : null
  const provider = target?.provider ?? null

  if (!jobUrl) {
    blockers.push('This posting has no application link on file.')
  } else if (!provider) {
    // Without a recognised official ATS there is nothing to prepare beyond the
    // link the user already has, so "approving" it in bulk would change a
    // status and nothing else. That is precisely an item deserving a look.
    blockers.push('Not an official Greenhouse, Lever or Ashby posting — apply on the company’s own site.')
  }

  // Knock-outs from BOTH the live description and whatever the preparing run
  // already deferred. Either source alone pulls the item out of the batch: the
  // description may have changed since the draft was written, and a draft
  // prepared before a pattern was added still carries its own record.
  const knockouts = [
    ...new Set([...scanKnockouts(candidate.jobDescription), ...candidate.storedDeferred]),
  ]
  if (knockouts.length > 0) {
    blockers.push(
      `Asks about ${knockouts.join(', ')} — only you can answer that, so this one is not batchable.`
    )
  }

  // Identity completeness. Skipped when no provider was detected because
  // assessReadiness() short-circuits on a null provider and never reaches its
  // identity checks; that item is already blocked above, so nothing is lost.
  if (provider) {
    const readiness = assessReadiness({
      provider,
      hasCredential: candidate.hasCredential,
      profile: candidate.profile,
      jobDescription: candidate.jobDescription,
      resumeSummary: candidate.resumeSummary,
    })
    for (const issue of readiness.issues) {
      if (isIdentityGap(issue)) blockers.push(issue)
    }

    return {
      batchable: blockers.length === 0,
      // The ceiling. See BatchDecision.mode for why this is deliberately the
      // looser of the two gates.
      mode: readiness.ready ? 'submit' : 'handoff',
      provider,
      knockouts,
      blockers,
    }
  }

  return { batchable: false, mode: 'handoff', provider, knockouts, blockers }
}

// --- The address applications are sent FROM ---------------------------------

/** Matches readiness.ts's own validity test, so the manifest and the apply
 *  gate never disagree about whether an address is usable. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export interface ResolvedApplyEmail {
  /** The address that will actually appear on applications. */
  address: string
  source: 'settings' | 'account'
  /** What was configured, if anything — shown even when it is unusable. */
  configured: string | null
  /** True when an address was configured but is not a valid address. */
  invalid: boolean
}

/**
 * The email a user applies WITH may differ from the email they log in WITH —
 * a student signs up with a university address and applies from a personal one,
 * or the reverse. Reads `preferences.contact.applyEmail` (the same
 * `preferences.contact` bag lib/ats-apply's buildApplyProfile already reads
 * phone/location/linkedin from), then a top-level `preferences.applyEmail`.
 *
 * A configured-but-malformed address is reported, never silently swapped for
 * the account address: the confirmation step names the address applications
 * will carry, and that promise has to be true.
 */
export function resolveApplyEmail(preferences: unknown, accountEmail: string): ResolvedApplyEmail {
  const account = (accountEmail ?? '').trim()
  const configured = readApplyEmailPreference(preferences)

  if (!configured) return { address: account, source: 'account', configured: null, invalid: false }
  if (!EMAIL_RE.test(configured)) {
    return { address: account, source: 'account', configured, invalid: true }
  }
  return { address: configured, source: 'settings', configured, invalid: false }
}

function readApplyEmailPreference(preferences: unknown): string | null {
  if (!preferences || typeof preferences !== 'object') return null
  const prefs = preferences as Record<string, unknown>

  const contact = prefs.contact
  if (contact && typeof contact === 'object') {
    const nested = (contact as Record<string, unknown>).applyEmail
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }

  const top = prefs.applyEmail
  if (typeof top === 'string' && top.trim()) return top.trim()

  return null
}
