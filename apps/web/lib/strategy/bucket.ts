// Strategy analytics — shared bucket-building helpers used by every
// questions/*.ts analyzer that compares groups of applications against each
// other (source, score band, resume variant, outreach group, timing bucket).

import { MIN_PER_BUCKET } from './thresholds'
import type { OutcomeBucket } from './types'
import type { ApplicationRow, ActivityRow } from './datasource'

/**
 * "Replied" = at least one activities row exists for this application.
 *
 * Grounded in how activities rows are actually created (see
 * lib/gmail/activity.ts + app/api/gmail/sync/route.ts, owned by the Gmail
 * workstream): a row is written ONLY when Gmail sync classifies an INBOUND
 * email as job-related for that application — there is no other writer of
 * `activities`. So "has an activity" is precisely "the employer/ATS sent
 * something back", independent of whether the stage itself advanced (a
 * confirmation email that doesn't change stage still writes an
 * 'email_received' row).
 */
export function repliedApplicationIds(activities: ActivityRow[]): Set<string> {
  return new Set(activities.map((a) => a.applicationId))
}

/** Stages that only exist once an employer has moved the candidate forward. */
const INTERVIEW_STAGES = new Set(['interview', 'offer', 'accepted'])

/**
 * "Interviewed" = the application's current stage is interview/offer/accepted,
 * OR an activities row of type 'interview_scheduled' was ever recorded (covers
 * the case where a later signal was ignored as a regression but an interview
 * was still genuinely scheduled at some point — see lib/gmail/stage.ts).
 * Deliberately excludes 'screen' — a phone screen is counted as a reply, not
 * yet a full interview; see the funnel label in each question's summary.
 */
export function interviewedApplicationIds(applications: ApplicationRow[], activities: ActivityRow[]): Set<string> {
  const ids = new Set<string>()
  for (const a of applications) if (INTERVIEW_STAGES.has(a.stage)) ids.add(a.id)
  for (const act of activities) if (act.type === 'interview_scheduled') ids.add(act.applicationId)
  return ids
}

export function buildBucket(label: string, apps: ApplicationRow[], repliedIds: Set<string>, interviewedIds: Set<string>): OutcomeBucket {
  const applications = apps.length
  const replies = apps.filter((a) => repliedIds.has(a.id)).length
  const interviews = apps.filter((a) => interviewedIds.has(a.id)).length
  return {
    label,
    applications,
    replies,
    interviews,
    replyRate: applications > 0 ? replies / applications : null,
    interviewRate: applications > 0 ? interviews / applications : null,
    thinBucket: applications < MIN_PER_BUCKET,
  }
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const arr = map.get(key)
    if (arr) arr.push(item)
    else map.set(key, [item])
  }
  return map
}

export function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`
}
