import { afterEach, describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import { chatOpen } from './shown'

afterEach(() => {
  delete process.env.OWNER_USER_ID
})

describe('chatOpen', () => {
  it('is off for everyone while the switch is off, and on for the owner', async () => {
    process.env.OWNER_USER_ID = 'owner'
    const db = makeFakeAdmin({ instance_flags: [{ key: 'chat_shown', on: false }] })
    expect(await chatOpen(db, 'someone')).toBe(false)
    expect(await chatOpen(db, null)).toBe(false)
    expect(await chatOpen(db, 'owner')).toBe(true)
  })

  it('is on for everyone once the owner turns the switch on', async () => {
    const db = makeFakeAdmin({ instance_flags: [{ key: 'chat_shown', on: true }] })
    expect(await chatOpen(db, 'someone')).toBe(true)
  })

  it('is off when the flag row is missing', async () => {
    expect(await chatOpen(makeFakeAdmin({ instance_flags: [] }), 'someone')).toBe(false)
  })
})
