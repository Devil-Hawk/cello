// Strategy analytics — synthetic, in-memory demo fixture.
//
// THIS NEVER TOUCHES THE DATABASE. Every row below is constructed in memory
// from a small set of hand-designed scenarios and returned through the exact
// same StrategyDataSource interface createSupabaseStrategyDataSource()
// implements — see datasource.ts. Its only purpose is to demonstrate the
// 'answered' path of every question in questions/*.ts once an account crosses
// the thresholds in thresholds.ts, as proof the honesty gate is not simply
// "always insufficient" but a real threshold that opens once there's enough
// evidence. app/api/strategy/route.ts wires this in behind an explicit
// `?demo=synthetic` query param that a caller must opt into — the default,
// unparameterized route always reads the real account.
//
// HOW EACH SCENARIO IS BUILT: a scenario is `n` synthetic applications to one
// company/source/function/seniority/score, split deterministically by index
// into four outcome groups (interview / screen / rejected / no-reply) plus
// two independent axes (tailored resume on file / outreach sent). The exact
// counts below were hand-derived so that, in aggregate across all scenarios,
// every question's sample size crosses its threshold AND at least two of its
// comparison buckets individually cross MIN_PER_BUCKET — see the per-question
// arithmetic in this workstream's report for the full derivation. Nothing
// here is randomized, so re-running the demo always produces the same
// numbers.

import type { StrategyDataSource, ApplicationRow, ActivityRow, ResumeDocumentRow, OutreachMessageRow, JobScopeCounts } from './datasource'
import type { Targeting } from '../targeting'

interface ResumeSpec {
  atsScore: number
  bullets: string[]
}

interface ScenarioSpec {
  key: string
  source: string
  company: string
  jobFunction: string
  seniority: string
  matchScore: number | null
  n: number
  /** Outcome split — must sum to <= n. Remainder = no-reply. */
  interviews: number
  screens: number
  rejections: number
  /** Applications idx < tailored get a resume_documents row (job-specific tailored resume). */
  tailored: number
  /** Applications idx < outreach get a 'sent' outreach_messages row. */
  outreach: number
  /** Days between jobs.posted_at and applications.applied_at, one entry per index (length n). */
  days: number[]
  /** Resume content for the first `tailored` indices, in index order. */
  resumes: ResumeSpec[]
}

const PHRASE_1 = 'Led migration of a legacy billing platform to a microservices architecture, cutting latency 40%'
const PHRASE_2 = 'Mentored three junior engineers and ran weekly architecture reviews'

function fillerResume(atsScore: number, extra: string): ResumeSpec {
  return { atsScore, bullets: [extra, 'Shipped features across the full stack in a fast-moving team.'] }
}

const SCENARIOS: ScenarioSpec[] = [
  {
    // Strong performer: high match_score, greenhouse, mostly interviews.
    key: 'A',
    source: 'greenhouse',
    company: 'Acme Robotics',
    jobFunction: 'engineering',
    seniority: 'mid',
    matchScore: 88,
    n: 14,
    interviews: 9,
    screens: 2,
    rejections: 1,
    tailored: 10,
    outreach: 8,
    // idx0-8 apply fast (1d), idx9-10 a bit slower (3d), idx11 (10d), idx12-13 late (20d).
    days: [1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 10, 20, 20],
    resumes: [
      { atsScore: 82, bullets: [PHRASE_1, 'Owned the checkout service on-call rotation.'] },
      { atsScore: 80, bullets: [PHRASE_1, 'Reduced p95 API latency by 25% via query caching.'] },
      { atsScore: 81, bullets: [PHRASE_1, 'Designed the event schema for the new billing pipeline.'] },
      { atsScore: 79, bullets: [PHRASE_1, 'Led a cross-team migration off the legacy job queue.'] },
      { atsScore: 83, bullets: [PHRASE_1, 'Wrote the runbook adopted by the whole platform team.'] },
      { atsScore: 78, bullets: [PHRASE_1, 'Cut CI build time from 22 to 9 minutes.'] },
      { atsScore: 84, bullets: [PHRASE_2, 'Introduced contract testing between two core services.'] },
      { atsScore: 77, bullets: [PHRASE_2, 'Presented the migration postmortem to the eng org.'] },
      { atsScore: 80, bullets: [PHRASE_2, 'Paired with new hires on their first on-call shift.'] },
      fillerResume(70, 'Built an internal CLI used by the whole team.'), // idx9 (screen, tailored)
      // idx10-13 not tailored — no resume entry
    ],
  },
  {
    // Mid-tier: lower match_score, lever, mixed outcome, real silence.
    key: 'B',
    source: 'lever',
    company: 'Globex',
    jobFunction: 'engineering',
    seniority: 'mid',
    matchScore: 60,
    n: 12,
    interviews: 1,
    screens: 1,
    rejections: 3,
    tailored: 2,
    outreach: 1,
    days: [2, 5, 6, 6, 6, 12, 12, 12, 12, 18, 18, 18],
    resumes: [
      { atsScore: 65, bullets: ['Maintained a Django monolith serving 2M requests/day.', 'On-call for the payments service.'] },
      fillerResume(60, 'Wrote integration tests for the reporting module.'), // idx1 (screen, tailored)
    ],
  },
  {
    // Thin source (ashby) and thin score band (70-84) — deliberately below MIN_PER_BUCKET.
    key: 'C',
    source: 'ashby',
    company: 'Initech',
    jobFunction: 'data',
    seniority: 'senior',
    matchScore: 72,
    n: 4,
    interviews: 0,
    screens: 1,
    rejections: 0,
    tailored: 2,
    outreach: 0,
    days: [4, 15, 15, 15],
    resumes: [
      fillerResume(68, 'Built the nightly ETL pipeline for the analytics warehouse.'), // idx0 (screen, tailored)
      fillerResume(66, 'Owned the data-quality dashboard.'), // idx1 (no-reply, tailored)
    ],
  },
  {
    // Thin source (arbeitnow), entirely unscored — mirrors the real corpus's job-board rows.
    key: 'D',
    source: 'arbeitnow',
    company: 'Umbrella Labs',
    jobFunction: 'product',
    seniority: 'junior',
    matchScore: null,
    n: 3,
    interviews: 0,
    screens: 0,
    rejections: 0,
    tailored: 0,
    outreach: 0,
    days: [2, 2, 2],
    resumes: [],
  },
  {
    // "Consistently rejects" company — high volume, high rejection rate, no interviews.
    key: 'E',
    source: 'themuse',
    company: 'Wonka Industries',
    jobFunction: 'operations',
    seniority: 'senior',
    matchScore: null,
    n: 6,
    interviews: 0,
    screens: 1,
    rejections: 5,
    tailored: 0,
    outreach: 0,
    days: [3, 7, 7, 7, 7, 7],
    resumes: [],
  },
]

const BASE_POSTED_AT = new Date('2026-06-01T00:00:00Z')

function buildScenario(spec: ScenarioSpec): {
  applications: ApplicationRow[]
  activities: ActivityRow[]
  resumeDocuments: ResumeDocumentRow[]
  outreachMessages: OutreachMessageRow[]
} {
  const applications: ApplicationRow[] = []
  const activities: ActivityRow[] = []
  const resumeDocuments: ResumeDocumentRow[] = []
  const outreachMessages: OutreachMessageRow[] = []

  const companyId = `company-${spec.key}`

  for (let idx = 0; idx < spec.n; idx++) {
    const jobId = `job-${spec.key}-${idx}`
    const appId = `app-${spec.key}-${idx}`

    let stage: string
    let activityType: string | null
    if (idx < spec.interviews) {
      stage = 'interview'
      activityType = 'interview_scheduled'
    } else if (idx < spec.interviews + spec.screens) {
      stage = 'screen'
      activityType = 'stage_change'
    } else if (idx < spec.interviews + spec.screens + spec.rejections) {
      stage = 'rejected'
      activityType = 'rejected'
    } else {
      stage = 'applied'
      activityType = null
    }

    const postedAt = BASE_POSTED_AT.toISOString()
    const appliedAt = new Date(BASE_POSTED_AT.getTime() + spec.days[idx] * 24 * 60 * 60 * 1000).toISOString()

    applications.push({
      id: appId,
      jobId,
      stage,
      appliedAt,
      createdAt: postedAt,
      applicationSource: 'harness/matcher',
      companyId,
      companyName: spec.company,
      jobSource: spec.source,
      jobPostedAt: postedAt,
      matchScore: spec.matchScore,
      jobFunction: spec.jobFunction,
      seniority: spec.seniority,
    })

    if (activityType) {
      activities.push({
        id: `activity-${spec.key}-${idx}`,
        applicationId: appId,
        type: activityType,
        occurredAt: appliedAt,
      })
    }

    if (idx < spec.tailored) {
      const resume = spec.resumes[idx] ?? fillerResume(60, 'Contributed across the stack.')
      resumeDocuments.push({
        id: `resume-${spec.key}-${idx}`,
        jobId,
        version: 1,
        source: 'tailored',
        atsScore: resume.atsScore,
        content: resume.bullets.join('\n'),
        contentJson: { sections: [{ heading: 'Experience', bullets: resume.bullets }] },
      })
    }

    if (idx < spec.outreach) {
      outreachMessages.push({
        id: `outreach-${spec.key}-${idx}`,
        jobId,
        companyId,
        status: 'sent',
        kind: 'initial',
        sentAt: postedAt,
      })
    }
  }

  return { applications, activities, resumeDocuments, outreachMessages }
}

/**
 * Build a StrategyDataSource backed entirely by the in-memory scenarios
 * above. Never touches the database — see the module doc.
 */
export function buildSyntheticFixture(): StrategyDataSource {
  const built = SCENARIOS.map(buildScenario)
  const applications = built.flatMap((b) => b.applications)
  const activities = built.flatMap((b) => b.activities)
  const resumeDocuments = built.flatMap((b) => b.resumeDocuments)
  const outreachMessages = built.flatMap((b) => b.outreachMessages)

  return {
    async getApplications() {
      return applications
    },
    async getActivities(applicationIds: string[]) {
      const ids = new Set(applicationIds)
      return activities.filter((a) => ids.has(a.applicationId))
    },
    async getResumeDocuments() {
      return resumeDocuments
    },
    async getOutreachMessages() {
      return outreachMessages
    },
    // Illustrative only — unlike createSupabaseStrategyDataSource's exact SQL
    // counts, these are approximate synthetic numbers over a fabricated
    // 8,000-job corpus, just large enough to demonstrate filterImpact's shape
    // (it doesn't need an outcome threshold to answer today — see
    // questions/filterImpact.ts). The applications above are the part of this
    // fixture that actually proves the honesty gate opens with real evidence.
    async getJobScopeCounts(targeting: Targeting): Promise<JobScopeCounts> {
      const totalJobs = 8000
      const jobsWithNoDescription = 5200
      const dimFraction: Record<string, number> = { functions: 0.42, seniority: 0.22, countries: 0.6, languages: 0.5 }
      let passingFraction = 1
      const excludedByDimension: Record<string, number> = {}

      const applyDim = (key: 'functions' | 'seniority' | 'countries' | 'languages', configured: boolean) => {
        if (!configured) return
        const frac = dimFraction[key]
        excludedByDimension[key] = Math.round(totalJobs * (1 - frac))
        passingFraction *= frac
      }
      applyDim('functions', targeting.functions.length > 0)
      applyDim('seniority', targeting.seniority.length > 0)
      applyDim('countries', targeting.countries.length > 0)
      applyDim('languages', targeting.languages.length > 0)
      if (targeting.remoteOnly) {
        excludedByDimension.remoteOnly = Math.round(totalJobs * 0.55)
        passingFraction *= 0.45
      }

      const totalPassingAllConfiguredFilters = Math.round(totalJobs * passingFraction)
      const excludedByKeywords = targeting.excludedKeywords.length > 0 || targeting.excludedCompanies.length > 0 ? Math.round(totalPassingAllConfiguredFilters * 0.08) : null
      const excludedByMinScoreHypothetical = targeting.minScore !== null ? Math.round(totalJobs * (targeting.minScore / 100) * 0.6) : null

      return {
        totalJobs,
        totalPassingAllConfiguredFilters,
        jobsWithNoDescription,
        excludedByDimension,
        excludedByKeywords,
        excludedByMinScoreHypothetical,
      }
    },
  }
}
