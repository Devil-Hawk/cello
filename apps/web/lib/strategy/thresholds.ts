// Strategy analytics — honesty thresholds.
//
// These numbers are a documented, PRAGMATIC floor, not a formal power
// calculation — this module does not know the true underlying response rate,
// so it cannot compute a proper sample-size-for-power number. The reasoning
// behind every constant below is the same: with fewer than ~5 observations in
// a group, ONE outcome flipping (one reply, one rejection) swings that group's
// rate by 20+ points, which makes the rate noise, not signal. Below the total
// threshold for a question, there usually are not even enough rows to form two
// comparable groups at all.
//
// MEASURED REALITY THIS WAS CALIBRATED AGAINST (2026-07-28, user
// 443cf3a0-0ae3-40a2-8f93-bc4c206c1ac6): 1 application, 0 contacts, 0
// activities, 0 outreach_messages, 1 resume_documents row. Every outcome
// question below is therefore expected to report insufficient_data against
// the real account today — that is the correct, honest behavior, not a bug.

/** Below this many observations in a single group, its rate is hidden (thinBucket = true) rather than shown as if it were reliable. */
export const MIN_PER_BUCKET = 5

/** Which sources create interviews — needs enough applications for at least two buckets to individually cross MIN_PER_BUCKET. */
export const MIN_TOTAL_FOR_SOURCE_FUNNEL = 15

/** What match_score range predicts responses — needs enough SCORED applications to form comparable bands. */
export const MIN_TOTAL_FOR_SCORE_ACCURACY = 20

/** Which resume variants perform better — needs enough applications with a resume_documents link. */
export const MIN_TOTAL_FOR_RESUME_VARIANTS = 10

/** Does outreach improve response rate — needs enough applications split across "had outreach" / "no outreach". */
export const MIN_TOTAL_FOR_OUTREACH_IMPACT = 20

/** Which companies/role families consistently reject — a single group (one company, one role family) needs this many applications before "consistently" means anything. */
export const MIN_PER_REJECTION_GROUP = 5

/** Are applications sent too late — needs enough applications with BOTH jobs.posted_at and applications.applied_at set. */
export const MIN_TOTAL_FOR_TIMING = 15

/** What evidence recurs in successful applications — needs enough successful (interview+) applications for a repeated phrase to mean anything. */
export const MIN_SUCCESSFUL_FOR_EVIDENCE = 8

/** A phrase must recur across at least this many DISTINCT successful applications to be reported (never a phrase that only appears once). */
export const MIN_PHRASE_OCCURRENCES = 3

/**
 * Below this quality_score a job is confirmed junk and is never counted
 * anywhere in filterImpact — mirrors lib/harness/agents/matcher.ts's own
 * QUALITY_REJECT_THRESHOLD gate (imported directly from lib/jobs/classify.ts,
 * not duplicated here) so this module's "how many jobs are in scope" number
 * matches what the scorer itself would actually consider.
 */
export const NOT_ENOUGH = (sampleSize: number, minRequired: number, subject: string) =>
  `Not enough data yet — have ${sampleSize}, need about ${minRequired} ${subject} to answer this.`
