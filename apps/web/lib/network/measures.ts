// The measures K26 owns, as plain functions over the owner's marks and over fixture cases.
//   T30  of people network.sync kept, the share that are real people the owner has been in touch with about his search
//   T31  of kept people with an employer, the share tied to the right one; employers taken from a relay or a personal domain
//   T32  follow-up nudges on scripted threads: due exactly when the rule says
// The owner marks a CSV of the people the sync kept and the senders it left out (scripts/network-measures.ts sheet).

import { nudgeFor, type NudgeInput } from './nudge'

export interface Mark {
  email: string
  /** The sync kept this address as a person. */
  kept: boolean
  /** The owner says this is a real person he has been in touch with about his search. */
  real: boolean
  /** The owner says the employer or application tie is right; null when the person has none. */
  tieRight: boolean | null
  /** The tie came from a relay or a personal domain. */
  tieFromRelayOrPersonal: boolean
}

export interface Score {
  value: number | null
  passed: boolean | null
  sample_n: number
  note: string
}

const pct = (n: number, d: number) => (d === 0 ? null : n / d)

/** T30: precision of the kept people; recall of the real people among those left out is reported beside it. */
export function scoreT30(marks: Mark[]): Score {
  const kept = marks.filter((m) => m.kept)
  const right = kept.filter((m) => m.real).length
  const leftOut = marks.filter((m) => !m.kept)
  const missed = leftOut.filter((m) => m.real).length
  const value = pct(right, kept.length)
  return {
    value,
    passed: value === null ? null : value >= 0.95,
    sample_n: kept.length,
    note: `${right} of ${kept.length} kept people are real; ${missed} of ${leftOut.length} left out were real people.`,
  }
}

/** T31: the share of kept people with an employer whose tie is right, and the count taken from a relay or a personal domain (must be 0). */
export function scoreT31(marks: Mark[]): Score {
  const tied = marks.filter((m) => m.kept && m.tieRight !== null)
  const right = tied.filter((m) => m.tieRight).length
  const bad = marks.filter((m) => m.kept && m.tieFromRelayOrPersonal).length
  const value = pct(right, tied.length)
  return { value, passed: value === null ? null : value >= 0.95 && bad === 0, sample_n: tied.length, note: `${right} of ${tied.length} ties are right; ${bad} came from a relay or a personal domain.` }
}

export interface NudgeCase {
  name: string
  input: NudgeInput
  due: boolean
}

/** T32: every scripted case is due exactly when the rule says. */
export function scoreT32(cases: NudgeCase[]): Score {
  const wrong = cases.filter((c) => nudgeFor(c.input).due !== c.due).map((c) => c.name)
  return { value: cases.length - wrong.length, passed: wrong.length === 0, sample_n: cases.length, note: wrong.length ? `Wrong: ${wrong.join(', ')}.` : `All ${cases.length} scripted threads are due exactly when the rule says.` }
}

const at = (s: string) => new Date(s)

/** The scripted threads of T32, on a fixture clock. */
export const T32_CASES: NudgeCase[] = [
  { name: 'yours unanswered, one day short', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }], now: at('2026-03-09T09:59:00Z') }, due: false },
  { name: 'yours unanswered, across a weekend', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }], now: at('2026-03-09T10:00:00Z') }, due: true },
  { name: 'theirs unanswered, Friday 19:00 is due Sunday 19:00', input: { thread: [{ direction: 'in', sent_at: '2026-03-06T19:00:00Z' }], now: at('2026-03-08T19:00:00Z') }, due: true },
  { name: 'theirs unanswered, a minute early', input: { thread: [{ direction: 'in', sent_at: '2026-03-06T19:00:00Z' }], now: at('2026-03-08T18:59:00Z') }, due: false },
  { name: 'a reply that answered', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }, { direction: 'in', sent_at: '2026-03-03T10:00:00Z' }], now: at('2026-03-04T10:00:00Z') }, due: false },
  { name: 'two unanswered follow-ups', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }, { direction: 'out', sent_at: '2026-03-09T10:00:00Z' }, { direction: 'out', sent_at: '2026-03-16T10:00:00Z' }], now: at('2026-04-30T00:00:00Z') }, due: false },
  { name: 'a person\'s own rule', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }], person: { after_yours_bd: 2 }, now: at('2026-03-04T10:00:00Z') }, due: true },
  { name: 'snoozed', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }], person: { snooze_until: '2026-03-20' }, now: at('2026-03-10T10:00:00Z') }, due: false },
  { name: 'a closed application', input: { thread: [{ direction: 'out', sent_at: '2026-03-02T10:00:00Z' }], closed: true, now: at('2026-04-01T10:00:00Z') }, due: false },
  { name: 'New York across the DST change', input: { thread: [{ direction: 'out', sent_at: '2026-03-06T17:00:00Z' }], rule: { after_yours_bd: 1 }, zone: 'America/New_York', now: at('2026-03-09T16:00:00Z') }, due: true },
]
