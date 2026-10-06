// What Cello learned: Keep acts only where it says, Not right deletes, Off and On toggle, an edit is the person's own.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandContext } from '../define'

const store = vi.hoisted(() => ({
  allLearnings: vi.fn(),
  setLearningStatus: vi.fn(async () => undefined),
  deleteLearning: vi.fn(async () => undefined),
  editLearning: vi.fn(async () => undefined),
}))
vi.mock('@/lib/learning/store', () => store)
vi.mock('@/lib/measures/owner', () => ({ isOwner: () => false }))

import { learnedDelete, learnedEdit, learnedKeep, learnedNotRight, learnedOff, learnedOn } from './people'

const rpc = vi.fn(async () => ({ error: null }))
const ctx = { userId: 'u1', admin: () => ({ rpc }) } as unknown as CommandContext

beforeEach(() => {
  vi.clearAllMocks()
})

describe('learned.*', () => {
  it('Keep moves a proposal to active and touches no rule for another effect', async () => {
    store.allLearnings.mockResolvedValue([{ id: 'l1', effect: 'rank.fresh', status: 'proposed', params: {} }])
    await learnedKeep.run(ctx, { id: 'l1' })
    expect(store.setLearningStatus).toHaveBeenCalledWith('u1', 'l1', 'active')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('Keep of a follow-up timing changes only the global rule, with only the numbers it names', async () => {
    store.allLearnings.mockResolvedValue([{ id: 'l2', effect: 'nudge.rule', status: 'proposed', params: { after_yours_bd: 3, group: 'ignored' } }])
    await learnedKeep.run(ctx, { id: 'l2' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('set_network_rule', { p_user: 'u1', p_contact: null, p_rule: { after_yours_bd: 3 } })
  })

  it('Not right deletes, Off and On toggle, Delete deletes', async () => {
    await learnedNotRight.run(ctx, { id: 'l3' })
    expect(store.deleteLearning).toHaveBeenCalledWith('u1', 'l3')
    await learnedOff.run(ctx, { id: 'l3' })
    expect(store.setLearningStatus).toHaveBeenLastCalledWith('u1', 'l3', 'off')
    await learnedOn.run(ctx, { id: 'l3' })
    expect(store.setLearningStatus).toHaveBeenLastCalledWith('u1', 'l3', 'active')
    await learnedDelete.run(ctx, { id: 'l3' })
    expect(store.deleteLearning).toHaveBeenCalledTimes(2)
  })

  it('an edit goes through the store, which makes it the person\'s own; a count refuses', async () => {
    await learnedEdit.run(ctx, { id: 'l4', statement: 'Prefer short notes' })
    expect(store.editLearning).toHaveBeenCalledWith('u1', 'l4', 'Prefer short notes')
    store.editLearning.mockRejectedValueOnce(new Error('A count is fixed at its source.'))
    await expect(learnedEdit.run(ctx, { id: 'l5', statement: 'x' })).rejects.toMatchObject({ status: 400 })
  })

  it('refuses a forged id shape', () => {
    expect(learnedKeep.input.safeParse({ id: '' }).success).toBe(false)
    expect(learnedKeep.input.safeParse({ id: 'l1', user_id: 'x' }).success).toBe(false)
  })
})
