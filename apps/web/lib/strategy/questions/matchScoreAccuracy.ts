// Question: "What match_score range actually predicts responses?"
// This is the one question explicitly framed as validating OR refuting the
// scoring rubric — see MatchScoreAccuracyData.verdict. It only ever gets set
// once at least two score bands individually cross MIN_PER_BUCKET; otherwise
// the whole question stays insufficient_data, exactly like every other one.

import { insufficientData, answered } from '../types'
import type { QuestionResult, MatchScoreAccuracyData, ScoreBandBucket } from '../types'
import type { ApplicationRow, ActivityRow } from '../datasource'
import { MIN_TOTAL_FOR_SCORE_ACCURACY, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'matchScoreAccuracy'

/** Mirrors lib/format.ts matchTone bands exactly, so a reported band means the same thing here as it does in the Opportunities UI. */
const BANDS: { label: string; min: number; max: number }[] = [
  { label: '0-49 (bad)', min: 0, max: 49 },
  { label: '50-69 (muted)', min: 50, max: 69 },
  { label: '70-84 (warn)', min: 70, max: 84 },
  { label: '85-100 (good)', min: 85, max: 100 },
]

export function analyzeMatchScoreAccuracy(applications: ApplicationRow[], activities: ActivityRow[]): QuestionResult<MatchScoreAccuracyData> {
  const total = applications.length
  const scored = applications.filter((a) => a.matchScore !== null)

  if (scored.length < MIN_TOTAL_FOR_SCORE_ACCURACY) {
    return insufficientData(
      QUESTION,
      scored.length,
      MIN_TOTAL_FOR_SCORE_ACCURACY,
      NOT_ENOUGH(scored.length, MIN_TOTAL_FOR_SCORE_ACCURACY, 'scored applications')
    )
  }

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)

  const bands: ScoreBandBucket[] = BANDS.map((b) => {
    const apps = scored.filter((a) => (a.matchScore as number) >= b.min && (a.matchScore as number) <= b.max)
    const bucket = buildBucket(b.label, apps, repliedIds, interviewedIds)
    return { ...bucket, min: b.min, max: b.max }
  })

  const comparable = bands.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      scored.length,
      MIN_TOTAL_FOR_SCORE_ACCURACY,
      `Not enough data yet — have ${scored.length} scored applications, but fewer than 2 score bands individually have ${MIN_PER_BUCKET}+ applications. Need about ${MIN_PER_BUCKET} applications in at least 2 different score bands to check whether score predicts response.`
    )
  }

  // Ordered low-to-high band; a rubric that predicts responses should show a
  // non-decreasing reply rate as the band rises. Compare only bands with
  // enough volume, in score order.
  const ordered = comparable.slice().sort((a, b) => a.min - b.min)
  let nonDecreasing = true
  for (let i = 1; i < ordered.length; i++) {
    if ((ordered[i].replyRate ?? 0) < (ordered[i - 1].replyRate ?? 0)) nonDecreasing = false
  }
  const lowest = ordered[0]
  const highest = ordered[ordered.length - 1]
  const rises = (highest.replyRate ?? 0) > (lowest.replyRate ?? 0)
  const verdict: MatchScoreAccuracyData['verdict'] = ordered.length < 2 ? 'inconclusive' : nonDecreasing && rises ? 'validates' : 'refutes'

  const summary =
    verdict === 'validates'
      ? `Reply rate rises with match_score across ${ordered.length} comparable bands (${lowest.label}: ${pct(lowest.replyRate)} -> ${highest.label}: ${pct(highest.replyRate)}) — the rubric's scores line up with real responses so far.`
      : verdict === 'refutes'
        ? `Reply rate does NOT rise with match_score across ${ordered.length} comparable bands (${lowest.label}: ${pct(lowest.replyRate)}, ${highest.label}: ${pct(highest.replyRate)}) — the scoring rubric is not currently predicting responses.`
        : `Only one score band has enough volume to report a rate; there isn't yet a second band to compare it against.`

  return answered(
    QUESTION,
    scored.length,
    MIN_TOTAL_FOR_SCORE_ACCURACY,
    { totalApplications: total, totalScored: scored.length, bands, verdict },
    summary,
    bands.length > comparable.length ? [`${bands.length - comparable.length} score band(s) have fewer than ${MIN_PER_BUCKET} applications and are listed but not compared.`] : []
  )
}
