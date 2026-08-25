// Strategy analytics — orchestrator.
//
// Cello vision task #15 ("strategy-brain"): turn outcome data into ANSWERS
// (with an honest sample size on every one) and turn answers into PROPOSED
// campaign changes for the user to approve — never a silent rewrite of
// targeting, never a chart for its own sake. See docs/PRODUCT-VISION.md's
// "Learn which strategies produce responses, interviews and offers" (item 11)
// and "Re-plan the search automatically when the strategy is not working"
// (item 12) — this module is what makes both of those honest instead of
// aspirational.
//
// THE HONESTY REQUIREMENT, restated for anyone editing this file: every
// outcome question (source funnel, match-score accuracy, resume variants,
// outreach impact, rejection patterns, application timing, recurring
// evidence) is wrapped in QuestionResult<T> and is STRUCTURALLY unable to
// report a rate below its documented minimum-n threshold (thresholds.ts) — the
// analyzer functions in questions/*.ts return insufficientData(...) before
// ever computing a rate when the count is too low, so there's no path where a
// caller could `.data` its way past the gate. filterImpact is the one
// exception, and it's an exception for a documented reason: it's a JOB-VOLUME
// question (20k+ rows exist regardless of outcome data), not an outcome
// question, and its own causal sub-claim ("is it too strict", i.e. hurting
// outcomes) is STILL gated — see questions/filterImpact.ts's causalEvidence.
//
// Run this against the real account and expect insufficient_data everywhere
// except filterImpact — that is the correct, honest output at n=1, not a bug.
// See lib/harness/agents/strategist.ts's coordination note for how a caller
// (the harness, once wired in) reaches this, and lib/strategy/fixtures.ts for
// a synthetic, in-memory dataset that demonstrates the 'answered' path.

import type { StrategyDataSource } from './datasource'
import type { Targeting } from '../targeting'
import type { StrategyReport } from './types'
import { analyzeSourceFunnel } from './questions/sourceFunnel'
import { analyzeMatchScoreAccuracy } from './questions/matchScoreAccuracy'
import { analyzeResumeVariants } from './questions/resumeVariants'
import { analyzeOutreachImpact } from './questions/outreachImpact'
import { analyzeRejectionPatterns } from './questions/rejectionPatterns'
import { analyzeApplicationTiming } from './questions/applicationTiming'
import { analyzeFilterImpact } from './questions/filterImpact'
import { analyzeRecurringEvidence } from './questions/recurringEvidence'
import { buildProposals } from './proposals'

export async function runStrategyAnalysis(dataSource: StrategyDataSource, userId: string, targeting: Targeting): Promise<StrategyReport> {
  const applications = await dataSource.getApplications()
  const applicationIds = applications.map((a) => a.id)

  const [activities, resumeDocuments, outreachMessages, jobScopeCounts] = await Promise.all([
    dataSource.getActivities(applicationIds),
    dataSource.getResumeDocuments(),
    dataSource.getOutreachMessages(),
    dataSource.getJobScopeCounts(targeting),
  ])

  const sourceFunnel = analyzeSourceFunnel(applications, activities)
  const matchScoreAccuracy = analyzeMatchScoreAccuracy(applications, activities)
  const resumeVariants = analyzeResumeVariants(applications, activities, resumeDocuments)
  const outreachImpact = analyzeOutreachImpact(applications, activities, outreachMessages)
  const rejectionPatterns = analyzeRejectionPatterns(applications, activities)
  const applicationTiming = analyzeApplicationTiming(applications, activities)
  const filterImpact = analyzeFilterImpact(jobScopeCounts, targeting)
  const recurringEvidence = analyzeRecurringEvidence(applications, resumeDocuments)

  const proposals = buildProposals({
    sourceFunnel,
    matchScoreAccuracy,
    resumeVariants,
    outreachImpact,
    rejectionPatterns,
    applicationTiming,
    recurringEvidence,
  })

  return {
    generatedAt: new Date().toISOString(),
    userId,
    totalApplications: applications.length,
    sourceFunnel,
    matchScoreAccuracy,
    resumeVariants,
    outreachImpact,
    rejectionPatterns,
    applicationTiming,
    filterImpact,
    recurringEvidence,
    proposals,
  }
}

export * from './types'
export type { StrategyDataSource } from './datasource'
export { createSupabaseStrategyDataSource } from './datasource'
