// Agent: strategist — turns outcome data (applications/activities/
// resume_documents/outreach_messages) plus the user's targeting preferences
// into (1) honestly-gated ANSWERS to the eight strategy questions in
// lib/strategy/questions/*.ts and (2) plain-language PROPOSED campaign
// changes for the user to approve. See lib/strategy/index.ts's module doc for
// the full honesty contract — this file is a thin AgentFn wrapper around
// runStrategyAnalysis(), it contains no analysis logic of its own.
//
// COORDINATION NOTE (not yet wired into the DAG): 'strategist' is NOT in
// AGENT_TYPES/STEP_AGENT_TYPES (lib/harness/schemas.ts) or registry.ts
// (lib/harness/registry.ts) — those are owned by the engine workstream. This
// file is shaped exactly like every other AgentFn (lib/harness/types.ts) so
// wiring it in is a small, mechanical change once that workstream is ready:
//   1. add 'strategist' to AGENT_TYPES + STEP_AGENT_TYPES in schemas.ts
//   2. add StrategistInput/StrategistOutput (below) to schemas.ts's
//      agentSchemas map (the zod shapes here already match the real return
//      value 1:1 — see lib/strategy/types.ts, which this schema mirrors)
//   3. import { strategist } from './agents/strategist' and add it to the
//      `registry` map in registry.ts
// Until then this agent is fully callable directly, and the SAME core
// (runStrategyAnalysis) is also what app/api/strategy/route.ts calls, so both
// paths stay in sync — exactly the contact_sourcer / /api/contacts/source
// pattern this coordination note is copied from.
//
// SAFETY: this agent only ever READS applications/activities/resume_documents/
// outreach_messages/jobs/companies/profiles and returns proposals as DATA.
// It never writes to profiles.preferences.targeting, resume_documents, or any
// other table, and it never sends anything — turning a proposal into an
// actual applied change stays a separate, human-gated step (a future
// /api/strategy/proposals/:id/approve route, owned by whichever workstream
// wires the UI up, not this one). See lib/strategy/proposals.ts's module doc.

import { z } from 'zod'
import type { AgentFn } from '../types'
import { runStrategyAnalysis } from '../../strategy'
import { createSupabaseStrategyDataSource } from '../../strategy/datasource'
import { buildSyntheticFixture } from '../../strategy/fixtures'
import { resolveTargeting } from '../../targeting'

export const StrategistInput = z.object({
  /**
   * Demo-only escape hatch — routes to the in-memory synthetic fixture
   * (lib/strategy/fixtures.ts) instead of the real database. NEVER set this
   * from a real planned run; it exists so the same AgentFn contract can
   * demonstrate the 'answered' path without 50 real applications. Mirrors
   * app/api/strategy/route.ts's `?demo=synthetic` query param.
   */
  useSyntheticDemo: z.boolean().optional(),
})

// --- Output schema — mirrors lib/strategy/types.ts's StrategyReport 1:1 ------

const OutcomeBucketSchema = z.object({
  label: z.string(),
  applications: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  interviews: z.number().int().nonnegative(),
  replyRate: z.number().nullable(),
  interviewRate: z.number().nullable(),
  thinBucket: z.boolean(),
})

function questionResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('insufficient_data'),
      question: z.string(),
      sampleSize: z.number().int().nonnegative(),
      minRequired: z.number().int().positive(),
      message: z.string(),
    }),
    z.object({
      status: z.literal('answered'),
      question: z.string(),
      sampleSize: z.number().int().nonnegative(),
      minRequired: z.number().int().positive(),
      data: dataSchema,
      summary: z.string(),
      caveats: z.array(z.string()),
    }),
  ])
}

const SourceFunnelDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithKnownSource: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const ScoreBandBucketSchema = OutcomeBucketSchema.extend({ min: z.number(), max: z.number() })
const MatchScoreAccuracyDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalScored: z.number().int().nonnegative(),
  bands: z.array(ScoreBandBucketSchema),
  verdict: z.enum(['validates', 'refutes', 'inconclusive']),
})

const ResumeVariantDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithResumeLink: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const OutreachImpactDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalOutreachMessagesSent: z.number().int().nonnegative(),
  buckets: z.array(OutcomeBucketSchema),
})

const RejectionGroupSchema = z.object({
  kind: z.enum(['company', 'job_function', 'seniority']),
  key: z.string(),
  totalApplications: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  rejectionRate: z.number(),
})
const RejectionPatternsDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalRejected: z.number().int().nonnegative(),
  groups: z.array(RejectionGroupSchema),
  groupsTooThinToReport: z.number().int().nonnegative(),
})

const TimingBucketSchema = OutcomeBucketSchema.extend({ minDays: z.number(), maxDays: z.number().nullable() })
const ApplicationTimingDataSchema = z.object({
  totalApplications: z.number().int().nonnegative(),
  totalWithTimestamps: z.number().int().nonnegative(),
  medianDaysToApply: z.number().nullable(),
  buckets: z.array(TimingBucketSchema),
})

const FilterDimensionImpactSchema = z.object({
  dimension: z.enum(['functions', 'seniority', 'countries', 'remoteOnly', 'languages', 'excludedCompanies', 'excludedKeywords', 'minScore (not enforced)']),
  configured: z.boolean(),
  jobsExcludedByThisAlone: z.number().int().nonnegative(),
})
const FilterImpactDataSchema = z.object({
  totalJobsInScope: z.number().int().nonnegative(),
  totalPassingAllConfiguredFilters: z.number().int().nonnegative(),
  totalExcluded: z.number().int(),
  jobsWithNoDescription: z.number().int().nonnegative(),
  dimensions: z.array(FilterDimensionImpactSchema),
  compSponsorshipFilterExists: z.literal(false),
  compSponsorshipNote: z.string(),
  causalEvidence: questionResultSchema(z.object({ note: z.string() })),
})

const EvidencePhraseSchema = z.object({
  phrase: z.string(),
  occurrences: z.number().int().nonnegative(),
  applicationIds: z.array(z.string()),
})
const RecurringEvidenceDataSchema = z.object({
  totalSuccessfulApplications: z.number().int().nonnegative(),
  phrases: z.array(EvidencePhraseSchema),
})

const StrategyProposalSchema = z.object({
  id: z.string(),
  title: z.string(),
  change: z.string(),
  why: z.string(),
  evidence: z.array(z.object({ question: z.string(), sampleSize: z.number().int().nonnegative(), summary: z.string() })),
  expectedEffect: z.string(),
  status: z.literal('proposed'),
})

export const StrategistOutput = z.object({
  generatedAt: z.string(),
  userId: z.string(),
  totalApplications: z.number().int().nonnegative(),
  sourceFunnel: questionResultSchema(SourceFunnelDataSchema),
  matchScoreAccuracy: questionResultSchema(MatchScoreAccuracyDataSchema),
  resumeVariants: questionResultSchema(ResumeVariantDataSchema),
  outreachImpact: questionResultSchema(OutreachImpactDataSchema),
  rejectionPatterns: questionResultSchema(RejectionPatternsDataSchema),
  applicationTiming: questionResultSchema(ApplicationTimingDataSchema),
  filterImpact: FilterImpactDataSchema,
  recurringEvidence: questionResultSchema(RecurringEvidenceDataSchema),
  proposals: z.array(StrategyProposalSchema),
})

export const strategist: AgentFn = async (ctx) => {
  const input = StrategistInput.parse(ctx.input ?? {})

  let targeting = resolveTargeting({})
  if (!input.useSyntheticDemo) {
    const { data: profile, error } = await ctx.admin.from('profiles').select('preferences').eq('id', ctx.userId).single()
    if (error) console.error('[strategy] strategist: profile fetch failed', error)
    targeting = resolveTargeting(profile?.preferences ?? {})
  }

  const dataSource = input.useSyntheticDemo ? buildSyntheticFixture() : createSupabaseStrategyDataSource(ctx.admin, ctx.userId)
  const report = await runStrategyAnalysis(dataSource, ctx.userId, targeting)

  return { output: report, tokensUsed: 0 }
}
