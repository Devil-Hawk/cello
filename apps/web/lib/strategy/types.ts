// Strategy analytics — shared types.
//
// THE CENTRAL RULE (see thresholds.ts for the numbers, and the module doc on
// index.ts for the full rationale): every question this module answers is
// wrapped in QuestionResult<T>, a discriminated union with exactly two states:
//
//   'insufficient_data' — the honest default. Carries the ACTUAL sample size
//     observed and the minimum required, so the caller (UI, strategist agent,
//     a human reading the API response) can see exactly how far away real
//     confidence is. Never carries a rate, a trend, or a "leaning positive".
//
//   'answered' — the sample size crossed the documented minimum for THIS
//     question. Carries the data plus a plain-language `summary` and any
//     `caveats` that still qualify the finding (e.g. "still thin — expect
//     bucket rates to move markedly with 5-10 more applications").
//
// A finding can ONLY become 'answered' by crossing its threshold — there is no
// code path that lets a caller opt into seeing a rate computed from too few
// rows. That is the whole point: this module must be structurally incapable
// of reporting a trend from n=1.

/** A question's sample size didn't cross its documented minimum. */
export interface InsufficientData {
  status: 'insufficient_data'
  /** Slug identifying which question this is (matches StrategyReport keys). */
  question: string
  /** The REAL count observed — never fabricated, never rounded up. */
  sampleSize: number
  /** The minimum this question requires before it will report a rate. */
  minRequired: number
  /** Plain-language explanation, always of the form "not enough data yet — need about N ... to answer this". */
  message: string
}

/** A question's sample size crossed its documented minimum. */
export interface Answered<T> {
  status: 'answered'
  question: string
  sampleSize: number
  minRequired: number
  /** The question-specific finding. */
  data: T
  /** One or two sentences, plain language, grounded in `data`. */
  summary: string
  /**
   * Qualifiers that still apply even though the threshold was crossed — e.g.
   * "only 2 of 6 sources have enough volume to compare" or "the effect could
   * still be explained by which roles happened to get applied to first".
   * Empty array (not omitted) when the finding is genuinely clean, so callers
   * can always render `caveats.length` without an undefined check.
   */
  caveats: string[]
}

export type QuestionResult<T> = InsufficientData | Answered<T>

export function insufficientData(question: string, sampleSize: number, minRequired: number, message: string): InsufficientData {
  return { status: 'insufficient_data', question, sampleSize, minRequired, message }
}

export function answered<T>(
  question: string,
  sampleSize: number,
  minRequired: number,
  data: T,
  summary: string,
  caveats: string[] = []
): Answered<T> {
  return { status: 'answered', question, sampleSize, minRequired, data, summary, caveats }
}

// --- Per-question data shapes -----------------------------------------------

/** One comparable group within a question (a source, a score band, a resume variant, ...). */
export interface OutcomeBucket {
  /** Human-readable bucket label, e.g. "greenhouse", "70-84", "tailored resume on file". */
  label: string
  applications: number
  replies: number
  interviews: number
  /** null when applications === 0 (never divide by zero; never show 0/0 as 0%). */
  replyRate: number | null
  interviewRate: number | null
  /**
   * True when this bucket individually has fewer than the per-bucket minimum.
   * The bucket is still listed (so the shape of the funnel is visible) but its
   * rate should be rendered muted/greyed — one flip in a 2-application bucket
   * swings the rate by 50 points, so it is not evidence of anything on its own.
   */
  thinBucket: boolean
}

export interface SourceFunnelData {
  totalApplications: number
  /** Applications whose job has a known ingest source (jobs.source is not null). */
  totalWithKnownSource: number
  buckets: OutcomeBucket[]
}

export interface ScoreBandBucket extends OutcomeBucket {
  min: number
  max: number
}

export interface MatchScoreAccuracyData {
  totalApplications: number
  totalScored: number
  bands: ScoreBandBucket[]
  /**
   * 'validates' — reply rate rises with score band (rubric predicts responses).
   * 'refutes' — reply rate does NOT rise with score band, or is flat/inverted.
   * Only set when at least two bands individually cross the per-bucket minimum
   * (see thresholds.ts) — otherwise this whole question stays insufficient_data.
   */
  verdict: 'validates' | 'refutes' | 'inconclusive'
}

export interface ResumeVariantData {
  totalApplications: number
  /** Applications whose job_id has at least one resume_documents row. */
  totalWithResumeLink: number
  buckets: OutcomeBucket[]
}

export interface OutreachImpactData {
  totalApplications: number
  totalOutreachMessagesSent: number
  buckets: OutcomeBucket[]
}

export interface RejectionGroup {
  kind: 'company' | 'job_function' | 'seniority'
  key: string
  totalApplications: number
  rejected: number
  rejectionRate: number
}

export interface RejectionPatternsData {
  totalApplications: number
  totalRejected: number
  /** Only groups that individually crossed MIN_APPLICATIONS_PER_REJECTION_GROUP. */
  groups: RejectionGroup[]
  /** How many distinct company/role-family groups existed but were too thin to report. */
  groupsTooThinToReport: number
}

export interface TimingBucket extends OutcomeBucket {
  minDays: number
  maxDays: number | null
}

export interface ApplicationTimingData {
  totalApplications: number
  /** Applications with both jobs.posted_at and applications.applied_at set. */
  totalWithTimestamps: number
  medianDaysToApply: number | null
  buckets: TimingBucket[]
}

export interface FilterDimensionImpact {
  dimension: 'functions' | 'seniority' | 'countries' | 'remoteOnly' | 'languages' | 'excludedCompanies' | 'excludedKeywords' | 'minScore (not enforced)'
  configured: boolean
  /** Jobs excluded by THIS dimension alone, holding every other dimension open. */
  jobsExcludedByThisAlone: number
}

export interface FilterImpactData {
  totalJobsInScope: number
  totalPassingAllConfiguredFilters: number
  totalExcluded: number
  jobsWithNoDescription: number
  dimensions: FilterDimensionImpact[]
  /** This product has no dedicated comp/sponsorship targeting field today — see index.ts. */
  compSponsorshipFilterExists: false
  compSponsorshipNote: string
  /**
   * Whether loosening targeting correlates with better OUTCOMES (not just more
   * volume). This is always its own nested, separately-gated QuestionResult —
   * crossing the volume threshold above says nothing about whether the excluded
   * jobs would have converted better or worse, and conflating the two is
   * exactly the overclaim this module exists to prevent.
   */
  causalEvidence: QuestionResult<{ note: string }>
}

export interface EvidencePhrase {
  phrase: string
  /** Number of DISTINCT successful applications this phrase appeared in. */
  occurrences: number
  applicationIds: string[]
}

export interface RecurringEvidenceData {
  totalSuccessfulApplications: number
  phrases: EvidencePhrase[]
}

// --- The full report ---------------------------------------------------------

export interface StrategyReport {
  generatedAt: string
  userId: string
  /** Total applications this user has, regardless of whether any question could use them. */
  totalApplications: number
  sourceFunnel: QuestionResult<SourceFunnelData>
  matchScoreAccuracy: QuestionResult<MatchScoreAccuracyData>
  resumeVariants: QuestionResult<ResumeVariantData>
  outreachImpact: QuestionResult<OutreachImpactData>
  rejectionPatterns: QuestionResult<RejectionPatternsData>
  applicationTiming: QuestionResult<ApplicationTimingData>
  /** Not gated the same way — see FilterImpactData.causalEvidence for the part that is. */
  filterImpact: FilterImpactData
  recurringEvidence: QuestionResult<RecurringEvidenceData>
  proposals: StrategyProposal[]
}

// --- Proposals ---------------------------------------------------------------

/**
 * A proposed CHANGE derived from an 'answered' finding, in the user's own
 * plain language. Proposals are NEVER auto-applied — see index.ts's
 * buildProposals doc. The UI is expected to render this as an approve/dismiss
 * card and record the decision; nothing in this module writes to
 * profiles.preferences or resume_documents on its own.
 */
export interface StrategyProposal {
  id: string
  /** e.g. "Emphasize the platform-migration accomplishment for infrastructure roles." */
  title: string
  /** What would concretely change if approved. */
  change: string
  /** Why — references the evidence below in plain language. */
  why: string
  evidence: { question: string; sampleSize: number; summary: string }[]
  /** Plain-language, non-promissory — "may improve reply rate", never a guaranteed number. */
  expectedEffect: string
  /** Always 'proposed' — this module never marks its own proposal accepted/applied. */
  status: 'proposed'
}
