// Question: "Which sources create interviews?"
// Funnel: jobs.source (ingest channel — greenhouse/lever/ashby/arbeitnow/...)
// -> applications -> replies -> interviews. See bucket.ts for exactly what
// "reply" and "interview" mean and why.

import { insufficientData, answered } from '../types'
import type { QuestionResult, SourceFunnelData } from '../types'
import type { ApplicationRow, ActivityRow } from '../datasource'
import { MIN_TOTAL_FOR_SOURCE_FUNNEL, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, groupBy, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'sourceFunnel'

export function analyzeSourceFunnel(applications: ApplicationRow[], activities: ActivityRow[]): QuestionResult<SourceFunnelData> {
  const total = applications.length
  if (total < MIN_TOTAL_FOR_SOURCE_FUNNEL) {
    return insufficientData(QUESTION, total, MIN_TOTAL_FOR_SOURCE_FUNNEL, NOT_ENOUGH(total, MIN_TOTAL_FOR_SOURCE_FUNNEL, 'applications'))
  }

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)
  const withSource = applications.filter((a) => a.jobSource)
  const grouped = groupBy(withSource, (a) => a.jobSource as string)
  const buckets = [...grouped.entries()]
    .map(([source, apps]) => buildBucket(source, apps, repliedIds, interviewedIds))
    .sort((a, b) => b.applications - a.applications)

  const comparable = buckets.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      total,
      MIN_TOTAL_FOR_SOURCE_FUNNEL,
      `Not enough data yet — have ${total} applications across ${buckets.length} source(s), but fewer than 2 sources individually have ${MIN_PER_BUCKET}+ applications. Need about ${MIN_PER_BUCKET} applications from at least 2 different sources to compare them.`
    )
  }

  const best = [...comparable].sort((a, b) => (b.interviewRate ?? 0) - (a.interviewRate ?? 0))[0]
  const thin = buckets.length - comparable.length
  return answered(
    QUESTION,
    total,
    MIN_TOTAL_FOR_SOURCE_FUNNEL,
    { totalApplications: total, totalWithKnownSource: withSource.length, buckets },
    `Across ${comparable.length} comparable source(s) (${total} applications total), ${best.label} has the highest interview rate at ${pct(best.interviewRate)} (${best.interviews}/${best.applications}).`,
    thin > 0 ? [`${thin} source(s) have fewer than ${MIN_PER_BUCKET} applications and are listed but not ranked.`] : []
  )
}
