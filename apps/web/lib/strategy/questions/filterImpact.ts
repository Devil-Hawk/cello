// Question: "Is comp/sponsorship filtering too strict? (how many opportunities the filters killed)"
//
// IMPORTANT HONESTY NOTE — read before trusting this file's numbers: this
// product has NO dedicated compensation or visa-sponsorship targeting field.
// lib/targeting.ts's Targeting interface has functions/seniority/countries/
// remoteOnly/languages/minScore/excludedCompanies/excludedKeywords — nothing
// for comp or sponsorship specifically. The only way a user could approximate
// a comp/sponsorship filter today is via excludedKeywords (e.g. adding
// "unpaid" or "no sponsorship" as a keyword) — see compSponsorshipNote below,
// which always says so explicitly.
//
// What this DOES answer honestly, with a real sample size drawn from the
// user's whole job corpus (not from the near-empty outcome tables), is the
// broader question the prompt's framing sits inside: how many opportunities
// does targeting, AS CONFIGURED TODAY, remove, and which dimension removes the
// most. That is a volume question and this module can answer it right now —
// see index.ts for why this is the one question NOT gated behind an
// applications/outcome threshold.
//
// What it explicitly does NOT answer, and never fabricates an answer to, is
// whether relaxing any filter would have produced BETTER outcomes — that
// needs outcome data on jobs that were filtered out, and by construction the
// user never sees those jobs, so the product has no way to collect that
// signal today. See causalEvidence below, which is always insufficient_data
// for that structural reason, not a sample-size reason.
//
// FILTER SEMANTICS: mirrors lib/harness/agents/matcher.ts's
// passesQualityAndTargeting exactly (imported constants + the same
// "unclassified passes through" rule) — see datasource.ts's
// createSupabaseStrategyDataSource.getJobScopeCounts, which is where the
// actual counting queries live. This file only shapes the counts it receives
// into FilterImpactData.

import { insufficientData } from '../types'
import type { FilterImpactData, FilterDimensionImpact } from '../types'
import type { JobScopeCounts } from '../datasource'
import type { Targeting } from '../../targeting'

const DIMENSION_LABELS: Record<string, FilterDimensionImpact['dimension']> = {
  functions: 'functions',
  seniority: 'seniority',
  countries: 'countries',
  remoteOnly: 'remoteOnly',
  languages: 'languages',
}

export function analyzeFilterImpact(counts: JobScopeCounts, targeting: Targeting): FilterImpactData {
  const dimensions: FilterDimensionImpact[] = (['functions', 'seniority', 'countries', 'remoteOnly', 'languages'] as const).map((dim) => ({
    dimension: DIMENSION_LABELS[dim],
    configured: dim === 'remoteOnly' ? targeting.remoteOnly : (targeting[dim] as string[]).length > 0,
    jobsExcludedByThisAlone: counts.excludedByDimension[dim] ?? 0,
  }))

  if (targeting.excludedCompanies.length > 0 || targeting.excludedKeywords.length > 0) {
    dimensions.push({
      dimension: targeting.excludedKeywords.length > 0 ? 'excludedKeywords' : 'excludedCompanies',
      configured: true,
      jobsExcludedByThisAlone: counts.excludedByKeywords ?? 0,
    })
  }

  if (targeting.minScore !== null) {
    dimensions.push({
      dimension: 'minScore (not enforced)',
      configured: true,
      jobsExcludedByThisAlone: counts.excludedByMinScoreHypothetical ?? 0,
    })
  }

  const compSponsorshipNote =
    targeting.excludedKeywords.length > 0
      ? `No dedicated comp/sponsorship filter exists. If any of your excluded keywords (${targeting.excludedKeywords.join(', ')}) relate to compensation or sponsorship, they are counted in the excludedKeywords row above, not broken out separately — this product does not tag keywords by topic. Note ${counts.jobsWithNoDescription} of ${counts.totalJobs} jobs in your scope have no description text at all, so keyword filtering can only ever evaluate the title on those.`
      : 'No dedicated comp/sponsorship filter exists in this product today, and no excludedKeywords are configured to approximate one — this question cannot be answered even approximately until one of those changes.'

  return {
    totalJobsInScope: counts.totalJobs,
    totalPassingAllConfiguredFilters: counts.totalPassingAllConfiguredFilters,
    totalExcluded: counts.totalJobs - counts.totalPassingAllConfiguredFilters,
    jobsWithNoDescription: counts.jobsWithNoDescription,
    dimensions,
    compSponsorshipFilterExists: false,
    compSponsorshipNote,
    causalEvidence: insufficientData(
      'filterImpactCausalEvidence',
      0,
      1,
      'Not enough data yet — 0 outcome observations on filtered-out jobs. This product never shows the user a job that targeting excluded, so there is no way to observe whether those jobs would have converted better or worse. Volume-only: this says how many jobs are excluded, not whether excluding them is costing interviews.'
    ),
  }
}
