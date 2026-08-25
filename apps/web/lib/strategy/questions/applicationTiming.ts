// Question: "Are applications sent too late?" (posted_at -> applied_at delta vs outcome)
// Only applications with BOTH jobs.posted_at and applications.applied_at set
// can be measured — applications.applied_at is null on every row created by
// the matcher's auto-discovery path (stage stays 'discovered' until an actual
// apply happens), so this is expected to be a small subset even once the
// account has volume.

import { insufficientData, answered } from '../types'
import type { QuestionResult, ApplicationTimingData, TimingBucket } from '../types'
import type { ApplicationRow, ActivityRow } from '../datasource'
import { MIN_TOTAL_FOR_TIMING, MIN_PER_BUCKET, NOT_ENOUGH } from '../thresholds'
import { buildBucket, interviewedApplicationIds, repliedApplicationIds, pct } from '../bucket'

const QUESTION = 'applicationTiming'

const RANGES: { label: string; minDays: number; maxDays: number | null }[] = [
  { label: 'same day (0)', minDays: 0, maxDays: 0 },
  { label: '1-3 days', minDays: 1, maxDays: 3 },
  { label: '4-7 days', minDays: 4, maxDays: 7 },
  { label: '8-14 days', minDays: 8, maxDays: 14 },
  { label: '15+ days', minDays: 15, maxDays: null },
]

function daysBetween(postedAt: string, appliedAt: string): number {
  const ms = new Date(appliedAt).getTime() - new Date(postedAt).getTime()
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)))
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function analyzeApplicationTiming(applications: ApplicationRow[], activities: ActivityRow[]): QuestionResult<ApplicationTimingData> {
  const total = applications.length
  const withTimestamps = applications.filter((a) => a.jobPostedAt && a.appliedAt)

  if (withTimestamps.length < MIN_TOTAL_FOR_TIMING) {
    return insufficientData(
      QUESTION,
      withTimestamps.length,
      MIN_TOTAL_FOR_TIMING,
      NOT_ENOUGH(withTimestamps.length, MIN_TOTAL_FOR_TIMING, 'applications with both a posting date and an applied date')
    )
  }

  const deltas = withTimestamps.map((a) => daysBetween(a.jobPostedAt as string, a.appliedAt as string))
  const medianDaysToApply = median(deltas)

  const repliedIds = repliedApplicationIds(activities)
  const interviewedIds = interviewedApplicationIds(applications, activities)

  const buckets: TimingBucket[] = RANGES.map((r) => {
    const apps = withTimestamps.filter((a) => {
      const d = daysBetween(a.jobPostedAt as string, a.appliedAt as string)
      return d >= r.minDays && (r.maxDays === null || d <= r.maxDays)
    })
    const bucket = buildBucket(r.label, apps, repliedIds, interviewedIds)
    return { ...bucket, minDays: r.minDays, maxDays: r.maxDays }
  })

  const comparable = buckets.filter((b) => !b.thinBucket)
  if (comparable.length < 2) {
    return insufficientData(
      QUESTION,
      withTimestamps.length,
      MIN_TOTAL_FOR_TIMING,
      `Not enough data yet — have ${withTimestamps.length} applications with known timing, but fewer than 2 timing buckets individually have ${MIN_PER_BUCKET}+ applications. Need about ${MIN_PER_BUCKET} applications in at least 2 different timing buckets to compare.`
    )
  }

  const ordered = comparable.slice().sort((a, b) => a.minDays - b.minDays)
  const fastest = ordered[0]
  const slowest = ordered[ordered.length - 1]
  const fasterIsBetter = (fastest.replyRate ?? 0) >= (slowest.replyRate ?? 0)

  return answered(
    QUESTION,
    withTimestamps.length,
    MIN_TOTAL_FOR_TIMING,
    { totalApplications: total, totalWithTimestamps: withTimestamps.length, medianDaysToApply, buckets },
    fasterIsBetter
      ? `Applying ${fastest.label} after posting has a higher reply rate (${pct(fastest.replyRate)}) than applying ${slowest.label} (${pct(slowest.replyRate)}). Median time to apply is ${medianDaysToApply} day(s).`
      : `Applying later (${slowest.label}) has a reply rate of ${pct(slowest.replyRate)}, at or above applying ${fastest.label} (${pct(fastest.replyRate)}) — no evidence yet that faster is better. Median time to apply is ${medianDaysToApply} day(s).`,
    []
  )
}
