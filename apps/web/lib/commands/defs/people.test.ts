// The people commands refuse what the rule and the person's own rows forbid, before anything is written.

import { describe, expect, it, vi } from 'vitest'
import { networkSetRule, peopleAdd, peopleEdit, peopleImport } from './people'

vi.mock('@/lib/measures/owner', () => ({ isOwner: () => false }))

describe('network.set_rule', () => {
  const ok = (rule: unknown) => networkSetRule.input.safeParse({ rule }).success
  it('refuses 0 and 31 business days and 15 days after their reply', () => {
    expect(ok({ after_yours_bd: 0 })).toBe(false)
    expect(ok({ after_yours_bd: 31 })).toBe(false)
    expect(ok({ after_theirs_d: 15 })).toBe(false)
    expect(ok({ after_yours_bd: 5, after_theirs_d: 2 })).toBe(true)
  })
  it('takes a snooze date, an off switch and a return to the default, and no other key', () => {
    expect(ok({ snooze_until: '2026-03-20' })).toBe(true)
    expect(ok({ snooze_until: 'next week' })).toBe(false)
    expect(ok({ off: true })).toBe(true)
    expect(ok(null)).toBe(true)
    expect(ok({ turbo: 1 })).toBe(false)
  })
})

describe('people input', () => {
  it('a person needs a name, and an email must look like one', () => {
    expect(peopleAdd.input.safeParse({ name: '' }).success).toBe(false)
    expect(peopleAdd.input.safeParse({ name: 'Dana Lee', email: 'not an email' }).success).toBe(false)
    expect(peopleAdd.input.safeParse({ name: 'Dana Lee', email: 'DANA@ramp.com' }).data?.email).toBe('dana@ramp.com')
  })
  it('refuses a forged owner and an unknown field', () => {
    expect(peopleEdit.input.safeParse({ id: 'c1', user_id: 'someone-else' }).success).toBe(false)
    expect(peopleImport.input.safeParse({ rows: [] }).success).toBe(false)
  })
})
