// The five rules on fixture headers, ties, the person's alias, and the thread read.

import { describe, expect, it } from 'vitest'
import { PERSONAL, judge, judgeAddress, leftOutSentence, parseAddress, parseAddressList } from './filter'
import { employerTie } from './ties'
import { parseThread, readThread } from './sync'

const job = { job: true, twoWay: false, verifiedDomain: false }
const ruleOf = (from: string, headers: Parameters<typeof judge>[1] = {}, ctx = job) => {
  const c = parseAddress(from)!
  const v = judge(c, headers, ctx)
  return v.keep ? 'kept' : v.rule
}

describe('filter rules', () => {
  it('leaves out a no-reply that carries a person\'s display name', () => expect(ruleOf('Jane Doe <no-reply@acme.com>')).toBe('automated'))
  it('leaves out Auto-Submitted mail', () => expect(ruleOf('Jane Doe <jane@acme.com>', { autoSubmitted: 'auto-generated' })).toBe('automated'))
  it('leaves out a list mail from a real person', () => {
    expect(ruleOf('Jane Doe <jane@acme.com>', { listUnsubscribe: '<mailto:u@acme.com>' })).toBe('bulk')
    expect(ruleOf('Jane Doe <jane@acme.com>', { precedence: 'bulk' })).toBe('bulk')
  })
  it('leaves out "Jane Doe via Greenhouse" and any relay host', () => {
    expect(ruleOf('Jane Doe via Greenhouse <jane.doe@greenhouse-mail.io>')).toBe('relay')
    expect(ruleOf('Jane Doe via Acme <jane@acme.com>')).toBe('relay')
  })
  it('keeps a recruiter on gmail.com from a job thread, as a personal address', () => {
    const v = judge(parseAddress('Sam Park <sam.park@gmail.com>')!, {}, job)
    expect(v).toMatchObject({ keep: true, addressKind: 'personal', domain: 'gmail.com' })
    expect(PERSONAL).toBe('apart')
  })
  it('leaves out a sender with no name and role-word names', () => {
    expect(ruleOf('jane.doe@acme.com')).toBe('no_name')
    expect(ruleOf('"jane.doe@acme.com" <jane.doe@acme.com>')).toBe('no_name')
    expect(ruleOf('Talent Team <maria@acme.com>')).toBe('no_name')
  })
  it('a two-way thread with a friend on gmail.com makes no person', () => {
    expect(ruleOf('Pat Friend <pat@gmail.com>', {}, { job: false, twoWay: true, verifiedDomain: false })).toBe('not_human_mail')
  })
  it('a two-way thread at a domain that is not a verified employer makes no person; at a verified one it does', () => {
    expect(ruleOf('Lee Kim <lee@random.org>', {}, { job: false, twoWay: true, verifiedDomain: false })).toBe('not_human_mail')
    expect(ruleOf('Lee Kim <lee@ramp.com>', {}, { job: false, twoWay: true, verifiedDomain: true })).toBe('kept')
  })
  it('counts add to the total in the sentence', () => {
    expect(leftOutSentence({ automated: 160, bulk: 38, no_name: 16 })).toBe('Cello left out 214 senders: 160 automated, 38 bulk, 16 with no name.')
    expect(leftOutSentence({})).toBeNull()
  })
  it('judgeAddress reports no rule for a clean person', () => expect(judgeAddress(parseAddress('Dana Lee <dana@ramp.com>')!)).toBeNull())
})

describe('addresses', () => {
  it('splits a list on commas outside quotes', () => {
    expect(parseAddressList('"Reed, Marcus" <m@x.com>, Dana <d@y.com>, bare@z.org').map((c) => c.email)).toEqual(['m@x.com', 'd@y.com', 'bare@z.org'])
  })
})

describe('ties', () => {
  it('uses the verified domain first, then the thread, then the agency', () => {
    expect(employerTie({ addressKind: 'employer', domainEmployerId: 'e1', threadEmployerId: 'e2', agencyName: 'Hays' })).toMatchObject({ employerId: 'e1' })
    expect(employerTie({ addressKind: 'employer', domainEmployerId: null, threadEmployerId: 'e2', agencyName: 'Hays' })).toMatchObject({ employerId: 'e2' })
    expect(employerTie({ addressKind: 'employer', domainEmployerId: null, threadEmployerId: null, agencyName: 'Hays' })).toMatchObject({ agencyName: 'Hays' })
    expect(employerTie({ addressKind: 'employer', domainEmployerId: null, threadEmployerId: null, agencyName: null })).toBeNull()
  })
  it('a personal address never names an employer from its domain', () => {
    expect(employerTie({ addressKind: 'personal', domainEmployerId: 'gmail-employer', threadEmployerId: null, agencyName: null })).toBeNull()
    expect(employerTie({ addressKind: 'personal', domainEmployerId: 'gmail-employer', threadEmployerId: 'e2', agencyName: null })).toMatchObject({ employerId: 'e2' })
  })
})

const H = (name: string, value: string) => ({ name, value })
const msg = (id: string, ts: number, headers: Array<{ name: string; value: string }>) => ({ id, internalDate: String(ts), headers })

describe('a thread read', () => {
  const yours = new Set(['me@mail.com', 'alias@work.com'])
  const t0 = Date.UTC(2026, 2, 2, 10)

  it('treats the person\'s alias as you and keeps the other side', () => {
    const msgs = parseThread(
      {
        id: 't1',
        messages: [
          msg('a', t0, [H('From', 'Me <alias@work.com>'), H('To', 'Marcus Reed <marcus@petrichor.ai>')]),
          msg('b', t0 + 1000, [H('From', 'Marcus Reed <marcus@petrichor.ai>'), H('To', 'alias@work.com')]),
        ],
      },
      yours,
    )
    expect(msgs.map((m) => m.direction)).toEqual(['out', 'in'])
    const read = readThread(msgs, yours, { job: false, verified: (d) => d === 'petrichor.ai' })
    expect(read.kept.map((p) => p.email)).toEqual(['marcus@petrichor.ai'])
  })

  it('a sent mail nobody answered makes no person outside a job thread', () => {
    const msgs = parseThread({ id: 't2', messages: [msg('a', t0, [H('From', 'me@mail.com'), H('To', 'Dana Lee <dana@ramp.com>')])] }, yours)
    expect(readThread(msgs, yours, { job: false, verified: () => true }).kept).toEqual([])
    expect(readThread(msgs, yours, { job: true, verified: () => true }).kept.map((p) => p.email)).toEqual(['dana@ramp.com'])
  })

  it('counts each left-out sender once, with its rule', () => {
    const msgs = parseThread(
      {
        id: 't3',
        messages: [
          msg('a', t0, [H('From', 'Jobs Digest <digest@jobs.example.com>'), H('List-Unsubscribe', '<x>')]),
          msg('b', t0 + 1, [H('From', 'Jobs Digest <digest@jobs.example.com>'), H('List-Unsubscribe', '<x>')]),
        ],
      },
      yours,
    )
    const read = readThread(msgs, yours, { job: true, verified: () => false })
    expect(read.left).toEqual([{ keep: false, email: 'digest@jobs.example.com', rule: 'bulk' }])
  })

  it('a relay host never becomes an employer or a person', () => {
    const msgs = parseThread({ id: 't4', messages: [msg('a', t0, [H('From', 'Jane Doe via Greenhouse <jane@greenhouse-mail.io>')])] }, yours)
    const read = readThread(msgs, yours, { job: true, verified: () => true })
    expect(read.kept).toEqual([])
    expect(read.left[0].rule).toBe('relay')
  })
})
