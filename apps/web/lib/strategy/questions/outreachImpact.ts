// Question: "Does outreach improve response rate?"
// Links outreach_messages -> applications via job_id (falling back to
// company_id when a message wasn't tied to one specific job — e.g. a
// networking email sent before a specific role existed). Only messages with
// status === 'sent' count as outreach that actually happened; 'pending_review'
// / 'approved' / 'failed' / 'skipped' never reached the recipient.

import { insufficientData, answered } from '../types'
import type { QuestionResult, OutreachImpactData } from '../types'
import type { ApplicationRow, ActivityRow, OutreachMessageRow } from '../datasource'
import { MIN_TOTAL_FOR_OUTREACH_IMPACT, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'outreachImpact'

export function analyzeOutreachImpact(
  applications: ApplicationRow[],
  activities: ActivityRow[],
  outreachMessages: OutreachMessageRow[]
): QuestionResult<OutreachImpactData> {
  const total = applications.length
  const sent = outreachMessages.filter((m) => m.status === 'sent')

  if (total < MIN_TOTAL_FOR_OUTREACH_IMPACT) {
    return insufficientData(QUESTION, total, MIN_TOTAL_FOR_OUTREACH_IMPACT, NOT_ENOUGH(total, MIN_TOTAL_FOR_OUTREACH_IMPACT, 'applications'))
  }

  const jobIdsWithOutreach = new Set(sent.filter((m) => m.jobId).map((m) => m.jobId as string))
  const companyIdsWithOutreach = new Set(sent.filter((m) => !m.jobId && m.companyId).map((m) => m.companyId as string))

  const withOutreach = applications.filter((a) => jobIdsWithOutreach.has(a.jobId) || companyIdsWithOutreach.has(a.companyId))
  const withoutOutreach = applications.filter((a) => !jobIdsWithOutreach.has(a.jobId) && !companyIdsWithOutreach.has(a.companyId))

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)
  const buckets = [
    buildBucket('had outreach sent', withOutreach, repliedIds, interviewedIds),
    buildBucket('no outreach sent', withoutOutreach, repliedIds, interviewedIds),
  ]

  const comparable = buckets.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      total,
      MIN_TOTAL_FOR_OUTREACH_IMPACT,
      `Not enough data yet — ${withOutreach.length} application(s) had outreach sent and ${withoutOutreach.length} did not, but at least one side has fewer than ${MIN_PER_BUCKET}. Need about ${MIN_PER_BUCKET} applications on both sides to compare.`
    )
  }

  const [withB, withoutB] = buckets
  const outreachHelps = (withB.replyRate ?? 0) > (withoutB.replyRate ?? 0)
  return answered(
    QUESTION,
    total,
    MIN_TOTAL_FOR_OUTREACH_IMPACT,
    { totalApplications: total, totalOutreachMessagesSent: sent.length, buckets },
    outreachHelps
      ? `Outreach correlates with a higher reply rate so far: ${pct(withB.replyRate)} with outreach vs ${pct(withoutB.replyRate)} without.`
      : `Outreach does not currently correlate with a higher reply rate: ${pct(withB.replyRate)} with outreach vs ${pct(withoutB.replyRate)} without.`,
    ['Correlation only — applications with outreach may also differ in company, role, or timing, which this comparison does not control for.']
  )
}
