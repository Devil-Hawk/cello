// Follow-up timing counts: hand counts over fixture threads, and the 10-a-group threshold.

import { describe, expect, it } from 'vitest'
import { followUpGroups, timingCounts, type MessageRow } from './timing'

const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n, 12)).toISOString() // Sep 1, 2026 is a Tuesday

/** One thread: you wrote, waited `wait` calendar days, wrote again, and they did or did not answer. */
function thread(id: string, wait: number, answered: boolean, kind = 'recruiter'): MessageRow[] {
  const base = { contact_id: id, thread_id: id, contacts: { kind } }
  return [
    { ...base, direction: 'out', sent_at: day(0) },
    { ...base, direction: 'out', sent_at: day(wait) },
    ...(answered ? [{ ...base, direction: 'in' as const, sent_at: day(wait + 1) }] : []),
  ]
}
const many = (n: number, wait: number, answered: number, kind?: string) => Array.from({ length: n }, (_, i) => thread(`${wait}-${kind}-${i}`, wait, i < answered, kind)).flat()

describe('follow-up timing', () => {
  it('counts follow-ups by business days waited and whether the next message was theirs', () => {
    const g = followUpGroups([...thread('a', 1, true), ...thread('b', 1, false), ...thread('c', 8, false)])
    expect(g).toEqual([
      { who: 'Recruiters', waited: 3, sent: 2, answered: 1 },
      { who: 'Recruiters', waited: 8, sent: 1, answered: 0 },
    ])
  })

  it('a first message and a reply are not follow-ups', () => {
    expect(followUpGroups([{ contact_id: 'a', thread_id: 't', direction: 'out', sent_at: day(0) }, { contact_id: 'a', thread_id: 't', direction: 'in', sent_at: day(2) }])).toEqual([])
  })

  it('proposes a change to the global rule only past 10 follow-ups in each group and a clear gap', () => {
    const rows = [...many(10, 1, 6), ...many(10, 8, 2)]
    const [c] = timingCounts(followUpGroups(rows))
    expect(c).toMatchObject({ effect: 'nudge.rule', kind: 'timing', status: 'proposed', params: { after_yours_bd: 3 } })
    expect(c.statement).toBe('Recruiters answered follow-ups sent after 3 business days more often: 6 of 10, against 2 of 10 after 8 business days.')
  })

  it('says nothing from 9 follow-ups, from a small gap, or from one group alone', () => {
    expect(timingCounts(followUpGroups([...many(9, 1, 9), ...many(10, 8, 0)]))).toEqual([])
    expect(timingCounts(followUpGroups([...many(10, 1, 6), ...many(10, 8, 5)]))).toEqual([])
    expect(timingCounts(followUpGroups(many(12, 1, 12)))).toEqual([])
  })

  it('counts recruiters and other contacts apart', () => {
    const rows = [...many(10, 1, 9, 'referrer'), ...many(10, 8, 1, 'referrer'), ...many(10, 1, 5), ...many(10, 8, 5)]
    expect(timingCounts(followUpGroups(rows)).map((c) => c.key)).toEqual(['timing:follow-up:contacts'])
  })
})
