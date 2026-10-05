// Question: "Does Cello's chance call predict replies?"
// This is the one question framed as validating OR refuting the chance call.
// Strong, Possible and Stretch come off the job row (jobs.chance); a call that is
// right shows a reply rate that falls as the call weakens. The verdict is only
// set once at least two groups individually cross MIN_PER_BUCKET; otherwise the
// whole question stays insufficient_data, like every other one.

import { insufficientData, answered } from '../types'
import type { QuestionResult, ChanceAccuracyData, ChanceBucket } from '../types'
import type { ApplicationRow, ActivityRow } from '../datasource'
import { MIN_TOTAL_FOR_CHANCE_ACCURACY, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'chanceAccuracy'

/** Strongest first. The order is the claim being tested: replies should not rise as you read down. */
const CHANCES: { chance: ChanceBucket['chance']; label: string }[] = [
  { chance: 'strong', label: 'Strong' },
  { chance: 'possible', label: 'Possible' },
  { chance: 'stretch', label: 'Stretch' },
]

export function analyzeChanceAccuracy(applications: ApplicationRow[], activities: ActivityRow[]): QuestionResult<ChanceAccuracyData> {
  const total = applications.length
  const assessed = applications.filter((a) => a.chance === 'strong' || a.chance === 'possible' || a.chance === 'stretch')

  if (assessed.length < MIN_TOTAL_FOR_CHANCE_ACCURACY) {
    return insufficientData(
      QUESTION,
      assessed.length,
      MIN_TOTAL_FOR_CHANCE_ACCURACY,
      NOT_ENOUGH(assessed.length, MIN_TOTAL_FOR_CHANCE_ACCURACY, 'applications with a chance call')
    )
  }

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)

  const buckets: ChanceBucket[] = CHANCES.map((c) => ({
    ...buildBucket(c.label, assessed.filter((a) => a.chance === c.chance), repliedIds, interviewedIds),
    chance: c.chance,
  }))

  const comparable = buckets.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      assessed.length,
      MIN_TOTAL_FOR_CHANCE_ACCURACY,
      `Not enough data yet: have ${assessed.length} applications with a chance call, but fewer than 2 of Strong, Possible and Stretch individually have ${MIN_PER_BUCKET}+ applications. Need about ${MIN_PER_BUCKET} in at least 2 of them to check whether the call predicts replies.`
    )
  }

  // Strongest to weakest, only groups with enough volume. A call that predicts
  // replies should never show a higher reply rate further down the list.
  let nonIncreasing = true
  for (let i = 1; i < comparable.length; i++) {
    if ((comparable[i].replyRate ?? 0) > (comparable[i - 1].replyRate ?? 0)) nonIncreasing = false
  }
  const strongest = comparable[0]
  const weakest = comparable[comparable.length - 1]
  const falls = (strongest.replyRate ?? 0) > (weakest.replyRate ?? 0)
  const verdict: ChanceAccuracyData['verdict'] = nonIncreasing && falls ? 'validates' : 'refutes'

  const summary =
    verdict === 'validates'
      ? `Reply rate falls as the chance call weakens across ${comparable.length} comparable groups (${strongest.label}: ${pct(strongest.replyRate)}, ${weakest.label}: ${pct(weakest.replyRate)}). The calls line up with real replies so far.`
      : `Reply rate does not fall as the chance call weakens across ${comparable.length} comparable groups (${strongest.label}: ${pct(strongest.replyRate)}, ${weakest.label}: ${pct(weakest.replyRate)}). The chance call is not currently predicting replies.`

  return answered(
    QUESTION,
    assessed.length,
    MIN_TOTAL_FOR_CHANCE_ACCURACY,
    { totalApplications: total, totalAssessed: assessed.length, buckets, verdict },
    summary,
    buckets.length > comparable.length ? [`${buckets.length - comparable.length} chance group(s) have fewer than ${MIN_PER_BUCKET} applications and are listed but not compared.`] : []
  )
}
