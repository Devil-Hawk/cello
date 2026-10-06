// When a follow-up is due, in code (blueprint 4.9a, directive 39). After your message: business days, Monday
// to Friday, in the person's zone. After their reply: calendar days, weekends counted, so a reply on Friday at
// 19:00 is due Sunday at 19:00. One per person per thread; it stops after two unanswered follow-ups and never
// fires on a closed application. Pure: the clock and the zone come in, so T32's table runs on a fixture clock.

import { TZDate } from '@date-fns/tz'
import { addBusinessDays, addDays, differenceInBusinessDays, differenceInCalendarDays } from 'date-fns'

export interface NudgeRule {
  on: boolean
  after_yours_bd: number
  after_theirs_d: number
}
export const DEFAULT_RULE: NudgeRule = { on: true, after_yours_bd: 5, after_theirs_d: 2 }

/** A person's own rule, or null for "use my default". */
export interface PersonRule {
  after_yours_bd?: number
  after_theirs_d?: number
  off?: boolean
  snooze_until?: string | null
}

export interface ThreadMessage {
  direction: 'in' | 'out'
  sent_at: string
}

export interface NudgeInput {
  /** The thread's messages with this person, any order. */
  thread: ThreadMessage[]
  rule?: Partial<NudgeRule> | null
  person?: PersonRule | null
  /** An IANA zone, UTC when the person has none. */
  zone?: string
  now: Date
  /** The tied application is closed. */
  closed?: boolean
  firstName?: string
}

export type NudgeReason = 'none' | 'off' | 'snoozed' | 'closed' | 'stopped' | 'not_yet'
export type Nudge =
  | { due: true; waitingOn: 'them' | 'you'; since: Date; dueAt: Date; fact: string }
  | { due: false; reason: NudgeReason; message?: string }

/** Messages of yours at the end of the thread, with nothing from them after. */
function trailingOut(sorted: ThreadMessage[]): number {
  let n = 0
  for (let i = sorted.length - 1; i >= 0 && sorted[i].direction === 'out'; i--) n++
  return n
}

export function nudgeFor(i: NudgeInput): Nudge {
  const zone = i.zone || 'UTC'
  const rule = { ...DEFAULT_RULE, ...(i.rule ?? {}) }
  const person = i.person ?? {}
  if (!rule.on || person.off) return { due: false, reason: 'off' }
  if (i.closed) return { due: false, reason: 'closed' }
  const now = new TZDate(i.now, zone)
  if (person.snooze_until) {
    const [y, m, d] = person.snooze_until.split('-').map(Number)
    if (now < new TZDate(y, m - 1, d, zone)) return { due: false, reason: 'snoozed' }
  }
  const sorted = [...i.thread].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))
  const last = sorted[sorted.length - 1]
  if (!last) return { due: false, reason: 'none' }
  const lastAt = new TZDate(new Date(last.sent_at), zone)

  if (last.direction === 'out') {
    // the first of the trailing messages is the message, the rest are follow-ups
    if (trailingOut(sorted) >= 3) return { due: false, reason: 'stopped', message: 'No reply after two follow-ups. Cello stopped reminding you.' }
    const dueAt = addBusinessDays(lastAt, person.after_yours_bd ?? rule.after_yours_bd)
    if (now < dueAt) return { due: false, reason: 'not_yet' }
    const n = differenceInBusinessDays(now, lastAt)
    return { due: true, waitingOn: 'them', since: new Date(last.sent_at), dueAt: new Date(dueAt.getTime()), fact: `You wrote last, ${n} business day${n === 1 ? '' : 's'} ago.` }
  }
  const dueAt = addDays(lastAt, person.after_theirs_d ?? rule.after_theirs_d)
  if (now < dueAt) return { due: false, reason: 'not_yet' }
  const n = differenceInCalendarDays(now, lastAt)
  const who = i.firstName || 'They'
  return { due: true, waitingOn: 'you', since: new Date(last.sent_at), dueAt: new Date(dueAt.getTime()), fact: `${who} replied ${n} day${n === 1 ? '' : 's'} ago. You have not answered.` }
}
