// What the search says comes next for one application, by code over what is stored: mail that arrived,
// the person's stage and dates, and their own follow-up rule. One answer or none; the Applications page,
// Today and Needs you all read this one function, so they never disagree.
//
//   reply          a verified mail asked for something and nobody has answered
//   offer_due      an offer is waiting for the person
//   follow_up_due  applied, no word back, and the person's follow-up days have passed
//   gone_quiet     applied a long time ago, no word back: time to let it go or close it
//
// Nothing here helps with getting ready for an interview (Cello does not do that). Mail that could not be verified is not
// evidence of anything and never makes a next step.
//
// ponytail: standalone over stored rows. buildDigest (K8c) shares the same inputs once it is on main.

import type { NextStepKind } from './groups'

export interface NextStepInput {
  stage: string
  state: string | null
  closedReason: string | null
  appliedAt: string | null
  interviewAt: string | null
  /** The newest message from them, and whether the person answered after it. */
  lastInbound: { at: string; kind: string; trust: string } | null
  answeredAfterInbound: boolean
  /** The person's follow-up rule: draft after this many days, or off. */
  followUpDays: number | null
  now: Date
}

export interface NextStep {
  kind: NextStepKind
  sentence: string
  dueAt: string | null
}

const DAY = 86_400_000
const GONE_QUIET_DAYS = 30
const CLOSED_STAGES = new Set(['rejected', 'withdrawn', 'ghosted', 'accepted'])

/** Business days between two instants, Monday to Friday, whole days. */
export function businessDaysBetween(from: Date, to: Date): number {
  let n = 0
  for (let t = new Date(from.getTime() + DAY); t <= to; t = new Date(t.getTime() + DAY)) {
    const d = t.getUTCDay()
    if (d !== 0 && d !== 6) n++
  }
  return n
}

export function nextStep(a: NextStepInput): NextStep | null {
  if (a.closedReason || CLOSED_STAGES.has(a.stage) || a.state === 'skipped') return null
  const trusted = a.lastInbound && (a.lastInbound.trust === 'proven' || a.lastInbound.trust === 'person' || a.lastInbound.trust === 'confirmed')

  if (trusted && a.lastInbound && !a.answeredAfterInbound) {
    if (a.lastInbound.kind === 'offer') return { kind: 'offer_due', sentence: 'You have an offer waiting for an answer.', dueAt: null }
    if (a.lastInbound.kind === 'interview' || a.lastInbound.kind === 'recruiter' || a.lastInbound.kind === 'reply') {
      return { kind: 'reply', sentence: 'They wrote to you. Answer them.', dueAt: a.interviewAt }
    }
  }

  if (a.stage === 'applied' && a.appliedAt && !a.lastInbound) {
    const applied = new Date(a.appliedAt)
    const days = (a.now.getTime() - applied.getTime()) / DAY
    if (days >= GONE_QUIET_DAYS) return { kind: 'gone_quiet', sentence: `No word in ${Math.floor(days)} days. Follow up once more, or close it.`, dueAt: null }
    if (a.followUpDays !== null && businessDaysBetween(applied, a.now) >= a.followUpDays) {
      return { kind: 'follow_up_due', sentence: 'No word yet. Time to follow up.', dueAt: new Date(applied.getTime() + a.followUpDays * DAY).toISOString() }
    }
  }
  return null
}
