// Apply-readiness assessment — the code-level gate an application must clear
// before an automatic official-API submit. Reimplements the guardrails from
// career-ops `modes/apply.md` (preflight liveness intent, knock-out pre-scan,
// never-fabricate legal/work-auth/salary fields) as pure functions, so both the
// applier agent and the autopilot engine share one honest gate — independent of
// the harness `verifier` agent (owned elsewhere), which can call this too.

import type { ApplyProfile, ApplyProviderId } from './types'

export interface ReadinessInput {
  provider: ApplyProviderId | null
  /** Whether an official apply credential is configured for this provider. */
  hasCredential: boolean
  profile: ApplyProfile
  /** Job description text (scanned for knock-out questions). */
  jobDescription?: string | null
  resumeSummary?: string | null
  coverLetter?: string | null
}

export interface ReadinessResult {
  /** True only when an automatic official-API submit is safe to attempt. */
  ready: boolean
  /** True when the application can proceed but only via human handoff. */
  requiresHuman: boolean
  issues: string[]
}

// Knock-out question patterns (career-ops apply.md Step 5b). Their PRESENCE in a
// JD/form means a human must answer them — we never auto-answer these.
const KNOCKOUT_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'visa/sponsorship', re: /\b(visa\s+sponsorship|require\s+sponsorship|sponsor(?:ship)?\s+(?:now|in the future)|work\s+authorization|authorized to work|right to work)\b/i },
  { label: 'security clearance', re: /\b(security\s+clearance|clearance\s+required|ts\/sci|top secret)\b/i },
  { label: 'salary expectation', re: /\b(salary\s+(?:expectation|requirement|range)|expected\s+salary|desired\s+compensation)\b/i },
  { label: 'demographic/EEO', re: /\b(gender|ethnicity|race|veteran\s+status|disability\s+status|self-identif)/i },
]

/** Scan free text for knock-out questions we must defer to the human. */
export function scanKnockouts(text: string | null | undefined): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { label, re } of KNOCKOUT_PATTERNS) {
    if (re.test(text)) hits.push(label)
  }
  return [...new Set(hits)]
}

/**
 * Decide whether an application is safe to auto-submit via an official API.
 * The default posture is conservative: anything uncertain routes to a human
 * handoff (never a blind POST, never a fabricated answer).
 */
export function assessReadiness(input: ReadinessInput): ReadinessResult {
  const issues: string[] = []

  // 1) Provider must be a recognized official ATS.
  if (!input.provider) {
    return {
      ready: false,
      requiresHuman: true,
      issues: ['No supported official ATS (Greenhouse/Lever/Ashby) detected for this posting.'],
    }
  }

  // 2) Minimum identity completeness for any submission.
  if (!input.profile.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.profile.email)) {
    issues.push('Missing or invalid email on profile.')
  }
  if (!input.profile.firstName) {
    issues.push('Missing name on profile.')
  }
  if (!input.resumeSummary && !input.profile.resumeText) {
    issues.push('No resume content available to attach.')
  }

  // 3) Knock-out questions in the JD must be answered by a human.
  const knockouts = scanKnockouts(input.jobDescription)
  const humanRequiredByKnockout = knockouts.length > 0
  if (humanRequiredByKnockout) {
    issues.push(
      `Posting includes knock-out question(s) [${knockouts.join(', ')}] that must be answered by you, not auto-filled.`
    )
  }

  // 4) An automatic submit needs a configured official credential. Without one
  //    we can still prepare a prefilled handoff — but never an unattended POST.
  if (!input.hasCredential) {
    issues.push('No official ATS apply credential configured — routing to review/handoff.')
  }

  const hasBlockingIdentityGap = issues.some(
    (i) => i.startsWith('Missing') || i.startsWith('No resume')
  )

  const ready =
    !!input.provider &&
    input.hasCredential &&
    !humanRequiredByKnockout &&
    !hasBlockingIdentityGap

  return {
    ready,
    // Can proceed via handoff as long as identity basics exist.
    requiresHuman: !ready,
    issues,
  }
}
