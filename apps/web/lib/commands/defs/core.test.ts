import { describe, expect, it } from 'vitest'
import { makeFakeAdmin } from '@/lib/agents/testing/fake-admin'
import type { CommandContext } from '../define'
import { searchGet } from './core'

describe('search.get', () => {
  it('reads the saved targets', async () => {
    const admin = makeFakeAdmin({ profiles: [{ id: 'u1', preferences: { targeting: { role_types: ['ai-engineer', 'ml-engineer'] } } }] })
    const ctx = { userId: 'u1', admin: () => admin } as unknown as CommandContext
    const out = await searchGet.run(ctx, {})
    expect(out.configured).toBe(true)
    expect(out.fields.find((f) => f.key === 'role_types')?.value).toBe('ai-engineer, ml-engineer')
  })

  it('reads as not configured when nothing is saved', async () => {
    const admin = makeFakeAdmin({ profiles: [{ id: 'u1', preferences: {} }] })
    const out = await searchGet.run({ userId: 'u1', admin: () => admin } as unknown as CommandContext, {})
    expect(out.configured).toBe(false)
  })
})
