import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DispatchError, dispatchBrowserApplyWorkflow, revokeLivePhaseToken } from './dispatch'

describe('dispatchBrowserApplyWorkflow', () => {
  const saved = process.env.GH_ACTIONS_TOKEN
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (saved === undefined) delete process.env.GH_ACTIONS_TOKEN
    else process.env.GH_ACTIONS_TOKEN = saved
  })

  it('throws DispatchError without calling GitHub when GH_ACTIONS_TOKEN is unset', async () => {
    delete process.env.GH_ACTIONS_TOKEN
    await expect(dispatchBrowserApplyWorkflow({ draftId: 'd', phase: 'fill' })).rejects.toBeInstanceOf(DispatchError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws DispatchError on a non-2xx response', async () => {
    process.env.GH_ACTIONS_TOKEN = 'x'
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 404 }))
    await expect(dispatchBrowserApplyWorkflow({ draftId: 'd', phase: 'fill' })).rejects.toThrow(/404/)
  })
})

describe('revokeLivePhaseToken', () => {
  it('marks only the live (draft, phase) row consumed', async () => {
    const calls: [string, ...unknown[]][] = []
    const q: Record<string, unknown> = {}
    q.update = (v: unknown) => (calls.push(['update', v]), q)
    q.eq = (c: string, v: unknown) => (calls.push(['eq', c, v]), q)
    q.is = (c: string, v: unknown) => (calls.push(['is', c, v]), Promise.resolve({ error: null }))
    const admin = { from: (t: string) => (calls.push(['from', t]), q) }
    await revokeLivePhaseToken(admin as never, { draftId: 'd1', phase: 'submit' })
    expect(calls[0]).toEqual(['from', 'apply_phase_tokens'])
    expect(calls).toContainEqual(['eq', 'draft_id', 'd1'])
    expect(calls).toContainEqual(['eq', 'phase', 'submit'])
    expect(calls).toContainEqual(['is', 'consumed_at', null])
    expect((calls[1][1] as { consumed_at: string }).consumed_at).toBeTruthy()
  })

  it('never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = {
      from: () => {
        throw new Error('boom')
      },
    }
    await expect(revokeLivePhaseToken(admin as never, { draftId: 'd', phase: 'fill' })).resolves.toBeUndefined()
  })
})
