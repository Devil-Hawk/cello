// Question: "Which companies or role families consistently reject?"
// Groups by company and by job_function ("role family"). A group is only
// reported once it individually crosses MIN_PER_REJECTION_GROUP — "3 for 3
// rejected at one company" is an anecdote, not yet a pattern; this module
// will not call it one.

import { insufficientData, answered } from '../types'
import type { QuestionResult, RejectionPatternsData, RejectionGroup } from '../types'
import type { ApplicationRow, ActivityRow } from '../datasource'
import { MIN_PER_REJECTION_GROUP, NOT_ENOUGH } from '../thresholds'
import { groupBy } from '../bucket'

const QUESTION = 'rejectionPatterns'

// A minimum TOTAL applications floor before this question runs at all, so a
// single company with 5 rejections out of a 5-application account isn't
// reported as "the pattern" when it IS the entire account.
const MIN_TOTAL = MIN_PER_REJECTION_GROUP * 3

function isRejected(app: ApplicationRow, activities: ActivityRow[]): boolean {
  if (app.stage === 'rejected') return true
  return activities.some((act) => act.applicationId === app.id && act.type === 'rejected')
}

export function analyzeRejectionPatterns(applications: ApplicationRow[], activities: ActivityRow[]): QuestionResult<RejectionPatternsData> {
  const total = applications.length
  if (total < MIN_TOTAL) {
    return insufficientData(QUESTION, total, MIN_TOTAL, NOT_ENOUGH(total, MIN_TOTAL, 'applications'))
  }

  const rejectedFlags = new Map(applications.map((a) => [a.id, isRejected(a, activities)]))
  const totalRejected = [...rejectedFlags.values()].filter(Boolean).length

  const buildGroups = (kind: RejectionGroup['kind'], keyFn: (a: ApplicationRow) => string | null): RejectionGroup[] => {
    const withKey = applications.filter((a) => keyFn(a) !== null) as ApplicationRow[]
    const grouped = groupBy(withKey, (a) => keyFn(a) as string)
    const groups: RejectionGroup[] = []
    for (const [key, apps] of grouped) {
      if (apps.length < MIN_PER_REJECTION_GROUP) continue
      const rejected = apps.filter((a) => rejectedFlags.get(a.id)).length
      groups.push({ kind, key, totalApplications: apps.length, rejected, rejectionRate: rejected / apps.length })
    }
    return groups
  }

  const companyGroups = buildGroups('company', (a) => a.companyName)
  const roleGroups = buildGroups('job_function', (a) => a.jobFunction)
  const seniorityGroups = buildGroups('seniority', (a) => a.seniority)
  const allGroups = [...companyGroups, ...roleGroups, ...seniorityGroups].sort((a, b) => b.rejectionRate - a.rejectionRate)

  const totalDistinctGroups =
    new Set(applications.map((a) => a.companyName)).size +
    new Set(applications.map((a) => a.jobFunction).filter((v): v is string => v !== null)).size +
    new Set(applications.map((a) => a.seniority).filter((v): v is string => v !== null)).size
  const groupsTooThinToReport = totalDistinctGroups - allGroups.length

  if (allGroups.length === 0) {
    return insufficientData(
      QUESTION,
      total,
      MIN_TOTAL,
      `Not enough data yet — ${total} applications span too many different companies/role families for any single one to reach ${MIN_PER_REJECTION_GROUP} applications. Need about ${MIN_PER_REJECTION_GROUP} applications to the SAME company or role family to detect a pattern.`
    )
  }

  const worst = allGroups[0]
  return answered(
    QUESTION,
    total,
    MIN_TOTAL,
    { totalApplications: total, totalRejected, groups: allGroups, groupsTooThinToReport },
    `${worst.kind === 'company' ? worst.key : `the ${worst.key} role family`} has the highest rejection rate with enough volume to report: ${Math.round(worst.rejectionRate * 100)}% (${worst.rejected}/${worst.totalApplications}).`,
    groupsTooThinToReport > 0 ? [`${groupsTooThinToReport} other companies/role families have too few applications to report a rate.`] : []
  )
}
