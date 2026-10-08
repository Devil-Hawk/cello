// Reply time, stalls, why applications closed and follow-ups: hand counts on fixture rows, and the threshold's
// own sentence below each threshold.

import { describe, expect, it } from 'vitest'
import { shapeFindings } from './shape'
import type { ActivityRow, ApplicationRow, OutreachMessageRow } from './datasource'

const NOW = new Date('2026-10-06T12:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const app = (i: number, over: Partial<ApplicationRow> = {}): ApplicationRow => ({
  id: `a${i}`, jobId: `j${i}`, stage: 'applied', appliedAt: day(40), createdAt: day(40), applicationSource: null, companyId: 'c', companyName: 'Co', jobSource: null, jobPostedAt: null, chance: null, jobFunction: null, seniority: null, closedReason: null, ...over,
})
const reply = (i: number, daysAfterApplying: number, appliedDaysAgo = 40): ActivityRow => ({ id: `r${i}`, applicationId: `a${i}`, type: 'email_received', occurredAt: day(appliedDaysAgo - daysAfterApplying) })
const many = (n: number, over: (i: number) => Partial<ApplicationRow> = () => ({})) => Array.from({ length: n }, (_, i) => app(i, over(i)))

describe('below every threshold', () => {
  it('says each threshold sentence and states no number', () => {
    const s = shapeFindings(many(3), [reply(0, 2)], [], NOW)
    expect(s.working).toEqual([])
    expect(s.notWorking).toEqual([])
    expect(s.thresholds).toEqual([
      'How long replies take appears from 5 replies.',
      'Where applications stall appears from 10 open applications older than 3 weeks.',
      'Why applications close appears from 5 closed applications.',
      'Whether following up helps appears from 10 applications with a follow-up and 10 without.',
    ])
  })
})

describe('over their thresholds', () => {
  it('reply time is the median of days from applying to the first reply', () => {
    const apps = many(6)
    const acts = [reply(0, 1), reply(1, 3), reply(2, 4), reply(3, 6), reply(4, 9)]
    const s = shapeFindings(apps, acts, [], NOW)
    expect(s.working[0]).toMatchObject({ key: 'shape:reply-time', applications: 6, replies: 5, line: 'Replies came a median of 4 days after you applied: 5 replies from 6 sent.' })
  })

  it('an unconfirmed reply never reaches here: only the rows given are counted', () => {
    expect(shapeFindings(many(6), [], [], NOW).working).toEqual([])
  })

  it('stalls count open applications older than 3 weeks with no reply, not closed ones and not young ones', () => {
    const apps = [...many(12), app(20, { appliedAt: day(5) }), app(21, { closedReason: 'no_reply' })]
    const s = shapeFindings(apps, [reply(0, 2), reply(1, 2)], [], NOW)
    const stall = s.notWorking.find((f) => f.key === 'shape:stalls')!
    expect(stall).toMatchObject({ applications: 12, line: '10 of 12 open applications older than 3 weeks have had no reply.' })
  })

  it('why applications closed, most common first', () => {
    const reasons = ['no_reply', 'no_reply', 'no_reply', 'rejected', 'rejected', 'posting_closed']
    const s = shapeFindings(many(6, (i) => ({ closedReason: reasons[i], stage: 'rejected' })), [], [], NOW)
    expect(s.notWorking.find((f) => f.key === 'shape:closed')!.line).toBe('6 applications were closed: 3 no reply, 2 not selected, 1 posting closed.')
  })

  it('follow-ups: the rate with one against the rate without, in the list it belongs to', () => {
    const apps = many(20)
    const followed: OutreachMessageRow[] = apps.slice(0, 10).map((a, i) => ({ id: `o${i}`, jobId: a.jobId, companyId: null, status: 'sent', kind: 'follow_up', sentAt: day(10) }))
    const better = shapeFindings(apps, [...apps.slice(0, 6).map((a, i) => reply(i, 3)), reply(10, 3)], followed, NOW)
    expect(better.working.find((f) => f.key === 'shape:follow-ups')!.line).toBe('6 of 10 applications you followed up on got a reply, against 1 of 10 without a follow-up.')
    const worse = shapeFindings(apps, [reply(0, 3), ...[10, 11, 12, 13, 14].map((i) => reply(i, 3))], followed, NOW)
    expect(worse.notWorking.find((f) => f.key === 'shape:follow-ups')).toBeTruthy()
  })
})
