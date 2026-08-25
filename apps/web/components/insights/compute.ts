// Pure analytics for the /insights page — NO LLM, NO external calls.
//
// Everything here is computed from rows the caller already read (RLS-scoped) out
// of applications / jobs / activities / outreach_messages / follow_ups. Pure and
// framework-free so it is trivially testable and safe to import into a client
// page.

import type { PipelineStage } from '@/lib/format'
import { scoreBandFor, scoreBandLabel, type ScoreBand } from '@/lib/jobs/score-bands'

// --- Input row shapes (mirror the RLS-scoped selects in the page) ------------

export interface AppInput {
  id: string
  job_id: string | null
  stage: string
  applied_at: string | null
  source: string | null
  created_at: string
  updated_at: string
  /** From the joined job. */
  match_score: number | null
}

export interface ActivityInput {
  application_id: string
  type: string
  occurred_at: string | null
}

export interface OutreachInput {
  job_id: string | null
  status: string
  kind: string
  sent_at: string | null
}

export interface FollowUpInput {
  due_date: string
  is_completed: boolean
}

// --- Output shape ------------------------------------------------------------

export type { ScoreBand }

export interface Breakdown {
  key: string
  label: string
  applied: number
  responded: number
  responseRate: number | null
}

export interface Insights {
  totalApplications: number
  funnel: Record<PipelineStage, number>
  appliedCount: number
  respondedCount: number
  interviewedCount: number
  offeredCount: number
  ghostedCount: number
  responseRate: number | null
  interviewRate: number | null
  offerRate: number | null
  ghostRate: number | null
  /** Median days from applied_at to first response activity, or null. */
  medianTimeToFirstResponse: number | null
  /** Avg days an active app has sat in its current stage (proxy: now-updated_at). */
  avgTimeInCurrentStage: number | null
  outreachSent: number
  /** Threads with a detectable reply / total sent, or null when unknowable. */
  outreachReplyRate: number | null
  followUpsDue: number
  followUpsOverdue: number
  byScoreBand: Breakdown[]
  bySource: Breakdown[]
  byOutreach: Breakdown[]
}

const STAGES: PipelineStage[] = [
  'discovered',
  'applied',
  'screen',
  'interview',
  'offer',
  'ghosted',
  'rejected',
]

const DAY_MS = 24 * 60 * 60 * 1000

/** An app that has progressed at least to "applied" (has a real pipeline life). */
function everApplied(a: AppInput): boolean {
  return a.applied_at != null || a.stage !== 'discovered'
}

/** Heuristic: current stage reached at least a screen (a genuine employer response). */
function responded(a: AppInput): boolean {
  return a.stage === 'screen' || a.stage === 'interview' || a.stage === 'offer'
}

function interviewed(a: AppInput): boolean {
  return a.stage === 'interview' || a.stage === 'offer'
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 100)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

const RESPONSE_ACTIVITY = /screen|interview|reply|response|recruiter|call|phone/i

function buildBreakdown(
  apps: AppInput[],
  keyOf: (a: AppInput) => string,
  labelOf: (key: string) => string,
  order?: string[]
): Breakdown[] {
  const buckets = new Map<string, { applied: number; responded: number }>()
  for (const a of apps) {
    if (!everApplied(a)) continue
    const key = keyOf(a)
    const b = buckets.get(key) ?? { applied: 0, responded: 0 }
    b.applied += 1
    if (responded(a)) b.responded += 1
    buckets.set(key, b)
  }
  const keys = order
    ? order.filter((k) => buckets.has(k))
    : [...buckets.keys()].sort((x, y) => (buckets.get(y)!.applied - buckets.get(x)!.applied))
  return keys.map((key) => {
    const b = buckets.get(key)!
    return {
      key,
      label: labelOf(key),
      applied: b.applied,
      responded: b.responded,
      responseRate: rate(b.responded, b.applied),
    }
  })
}

export function computeInsights(
  apps: AppInput[],
  activities: ActivityInput[],
  outreach: OutreachInput[],
  followUps: FollowUpInput[],
  now: number = Date.now()
): Insights {
  // Funnel counts.
  const funnel = STAGES.reduce(
    (acc, s) => {
      acc[s] = 0
      return acc
    },
    {} as Record<PipelineStage, number>
  )
  for (const a of apps) {
    if (STAGES.includes(a.stage as PipelineStage)) funnel[a.stage as PipelineStage] += 1
  }

  const appliedList = apps.filter(everApplied)
  const appliedCount = appliedList.length
  const respondedCount = appliedList.filter(responded).length
  const interviewedCount = appliedList.filter(interviewed).length
  const offeredCount = appliedList.filter((a) => a.stage === 'offer').length
  const ghostedCount = appliedList.filter((a) => a.stage === 'ghosted').length

  // Time-to-first-response: applied_at → earliest response-ish activity after it.
  const activityByApp = new Map<string, ActivityInput[]>()
  for (const ev of activities) {
    if (!ev.occurred_at) continue
    const list = activityByApp.get(ev.application_id) ?? []
    list.push(ev)
    activityByApp.set(ev.application_id, list)
  }
  const responseDeltas: number[] = []
  for (const a of apps) {
    if (!a.applied_at) continue
    const appliedTs = Date.parse(a.applied_at)
    if (Number.isNaN(appliedTs)) continue
    const events = activityByApp.get(a.id) ?? []
    let earliest: number | null = null
    for (const ev of events) {
      const ts = Date.parse(ev.occurred_at as string)
      if (Number.isNaN(ts) || ts < appliedTs) continue
      if (!RESPONSE_ACTIVITY.test(ev.type)) continue
      if (earliest == null || ts < earliest) earliest = ts
    }
    if (earliest != null) responseDeltas.push(Math.round((earliest - appliedTs) / DAY_MS))
  }
  const medianTimeToFirstResponse = median(responseDeltas)

  // Avg time in current stage (proxy) for still-active apps.
  const activeStages: PipelineStage[] = ['applied', 'screen', 'interview']
  const ageDays: number[] = []
  for (const a of apps) {
    if (!activeStages.includes(a.stage as PipelineStage)) continue
    const ts = Date.parse(a.updated_at)
    if (Number.isNaN(ts)) continue
    ageDays.push(Math.max(0, (now - ts) / DAY_MS))
  }
  const avgTimeInCurrentStage =
    ageDays.length > 0 ? Math.round(ageDays.reduce((s, d) => s + d, 0) / ageDays.length) : null

  // Outreach.
  const sentOutreach = outreach.filter((o) => o.status === 'sent')
  const outreachSent = sentOutreach.length
  // We do not persist a reply signal on outreach_messages, so reply rate is not
  // computable from stored data — expose null so the UI shows "—" honestly.
  const outreachReplyRate: number | null = null
  const outreachJobIds = new Set(
    sentOutreach.map((o) => o.job_id).filter((id): id is string => !!id)
  )

  // Follow-ups due / overdue.
  let followUpsDue = 0
  let followUpsOverdue = 0
  for (const f of followUps) {
    if (f.is_completed) continue
    const due = Date.parse(f.due_date)
    if (Number.isNaN(due)) continue
    if (due < now) followUpsOverdue += 1
    else if (due <= now + DAY_MS) followUpsDue += 1
  }

  // "What's working" cuts.
  const byScoreBand = buildBreakdown(
    apps,
    (a) => scoreBandFor(a.match_score),
    (k) => scoreBandLabel(k as ScoreBand),
    ['strong', 'good', 'fair', 'weak', 'unscored']
  )
  const bySource = buildBreakdown(
    apps,
    (a) => a.source?.trim() || 'unknown',
    (k) => (k === 'unknown' ? 'Unknown source' : k)
  )
  const byOutreach = buildBreakdown(
    apps,
    (a) => (a.job_id && outreachJobIds.has(a.job_id) ? 'with' : 'without'),
    (k) => (k === 'with' ? 'With outreach sent' : 'No outreach'),
    ['with', 'without']
  )

  return {
    totalApplications: apps.length,
    funnel,
    appliedCount,
    respondedCount,
    interviewedCount,
    offeredCount,
    ghostedCount,
    responseRate: rate(respondedCount, appliedCount),
    interviewRate: rate(interviewedCount, appliedCount),
    offerRate: rate(offeredCount, appliedCount),
    ghostRate: rate(ghostedCount, appliedCount),
    medianTimeToFirstResponse,
    avgTimeInCurrentStage,
    outreachSent,
    outreachReplyRate,
    followUpsDue,
    followUpsOverdue,
    byScoreBand,
    bySource,
    byOutreach,
  }
}
