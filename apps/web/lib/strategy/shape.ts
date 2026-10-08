// What is working, the dimensions that need no comparison of groups (blueprint 4.8): how long replies take, where
// applications stall, why they closed, and whether following up was answered more often. Counted by code over the
// same rows as every other question, with a threshold each: below it the threshold's own sentence is returned and
// no number is. A reply is a trusted message (the data source drops unconfirmed ones).

import type { ActivityRow, ApplicationRow, OutreachMessageRow } from './datasource'

export const MIN_REPLIES_FOR_TIME = 5
export const MIN_OLD_FOR_STALLS = 10
export const MIN_CLOSED = 5
export const MIN_FOLLOW_UPS = 10
/** An application with no reply for this long has stalled. */
export const STALL_DAYS = 21

const DAY = 86_400_000

export interface ShapeFinding {
  key: string
  dimension: 'reply time' | 'stalls' | 'closed' | 'follow-ups'
  line: string
  applications: number
  replies: number
}

export interface Shape {
  working: ShapeFinding[]
  notWorking: ShapeFinding[]
  thresholds: string[]
}

const CLOSED_WORDS: Record<string, string> = { rejected: 'not selected', withdrew: 'you withdrew', no_reply: 'no reply', posting_closed: 'posting closed', skipped: 'skipped' }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function shapeFindings(apps: ApplicationRow[], activities: ActivityRow[], outreach: OutreachMessageRow[], now = new Date()): Shape {
  const out: Shape = { working: [], notWorking: [], thresholds: [] }
  const firstReply = new Map<string, number>()
  for (const a of activities) {
    const t = new Date(a.occurredAt).getTime()
    if (!firstReply.has(a.applicationId) || t < (firstReply.get(a.applicationId) as number)) firstReply.set(a.applicationId, t)
  }
  const sent = apps.filter((a) => a.appliedAt)

  // time to reply: calendar days from applying to the first trusted message back
  const days = sent.flatMap((a) => {
    const t = firstReply.get(a.id)
    return t === undefined ? [] : [Math.max(0, Math.floor((t - new Date(a.appliedAt as string).getTime()) / DAY))]
  })
  if (days.length < MIN_REPLIES_FOR_TIME) out.thresholds.push(`How long replies take appears from ${MIN_REPLIES_FOR_TIME} replies.`)
  else out.working.push({ key: 'shape:reply-time', dimension: 'reply time', applications: sent.length, replies: days.length, line: `Replies came a median of ${median(days)} ${median(days) === 1 ? 'day' : 'days'} after you applied: ${plural(days.length, 'reply', 'replies')} from ${sent.length} sent.` })

  // stalls: applied at least STALL_DAYS ago, still open, and nothing back
  const open = sent.filter((a) => !a.closedReason && !['rejected', 'withdrawn', 'accepted'].includes(a.stage))
  const old = open.filter((a) => now.getTime() - new Date(a.appliedAt as string).getTime() >= STALL_DAYS * DAY)
  if (old.length < MIN_OLD_FOR_STALLS) out.thresholds.push(`Where applications stall appears from ${MIN_OLD_FOR_STALLS} open applications older than ${STALL_DAYS / 7} weeks.`)
  else {
    const quiet = old.filter((a) => !firstReply.has(a.id))
    out.notWorking.push({ key: 'shape:stalls', dimension: 'stalls', applications: old.length, replies: old.length - quiet.length, line: `${quiet.length} of ${plural(old.length, 'open application')} older than ${STALL_DAYS / 7} weeks have had no reply.` })
  }

  // why applications closed
  const closed = apps.filter((a) => a.closedReason)
  if (closed.length < MIN_CLOSED) out.thresholds.push(`Why applications close appears from ${MIN_CLOSED} closed applications.`)
  else {
    const by = new Map<string, number>()
    for (const a of closed) by.set(a.closedReason as string, (by.get(a.closedReason as string) ?? 0) + 1)
    const list = [...by.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${CLOSED_WORDS[r] ?? r}`)
    out.notWorking.push({ key: 'shape:closed', dimension: 'closed', applications: closed.length, replies: 0, line: `${closed.length} ${closed.length === 1 ? 'application was' : 'applications were'} closed: ${list.join(', ')}.` })
  }

  // follow-ups: applications you followed up on against the rest
  const followed = new Set(outreach.filter((m) => m.status === 'sent' && m.kind === 'follow_up').map((m) => m.jobId).filter((id): id is string => !!id))
  const withF = sent.filter((a) => followed.has(a.jobId))
  const without = sent.filter((a) => !followed.has(a.jobId))
  if (withF.length < MIN_FOLLOW_UPS || without.length < MIN_FOLLOW_UPS) out.thresholds.push(`Whether following up helps appears from ${MIN_FOLLOW_UPS} applications with a follow-up and ${MIN_FOLLOW_UPS} without.`)
  else {
    const a = withF.filter((x) => firstReply.has(x.id)).length
    const b = without.filter((x) => firstReply.has(x.id)).length
    const f: ShapeFinding = { key: 'shape:follow-ups', dimension: 'follow-ups', applications: withF.length, replies: a, line: `${a} of ${withF.length} applications you followed up on got a reply, against ${b} of ${without.length} without a follow-up.` }
    ;(a / withF.length >= b / without.length ? out.working : out.notWorking).push(f)
  }
  return out
}
