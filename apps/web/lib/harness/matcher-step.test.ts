// The matcher step of the harness DAG (and so of the A2A matcher agent) judges through lib/roles/judge and reports the
// bands it wrote. It names no top picks, and it never calls a model itself.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const judge = vi.hoisted(() => ({ judgeRoles: vi.fn(), nextWaiting: vi.fn() }))
vi.mock('@/lib/roles/judge', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/roles/judge')>()), ...judge }))

import { fakeDb } from '@/lib/companies/fake-db'
import { registry } from './registry'

const readings = [
  { text: 'Strong Go', status: 'met', quote: 'built payment services in Go' },
  { text: 'Kubernetes', status: 'not_met', quote: null },
]
const ctx = (input: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) => {
  const { client } = fakeDb({ person_roles: [{ user_id: 'u1', job_id: 'j1', band: 'strong', readings, chance_detail: { gaps: ['Kubernetes'] } }] })
  return { admin: client, userId: 'u1', input, deps } as never
}

beforeEach(() => {
  judge.judgeRoles.mockReset()
  judge.nextWaiting.mockReset()
})

describe('matcher step', () => {
  it('judges the ids an upstream step handed on and reports the bands with their quotes and gaps', async () => {
    judge.judgeRoles.mockResolvedValue({ judged: ['j1'], stopped: null })
    const out = await registry.matcher(ctx({}, { source: { jobIds: ['j1', 'j2'] } }))
    expect(judge.judgeRoles.mock.calls[0].slice(1)).toEqual(['u1', ['j1', 'j2']])
    expect(out.output).toEqual({
      matches: [{ jobId: 'j1', chance: 'strong', highlights: ['Strong Go: built payment services in Go'], gaps: ['Kubernetes'] }],
      topJobIds: [],
      skippedReason: undefined,
      candidatesConsidered: 2,
    })
  })

  it('takes the next waiting roles when no ids are named, and says why when the door stopped it', async () => {
    judge.nextWaiting.mockResolvedValue(['j1'])
    judge.judgeRoles.mockResolvedValue({ judged: [], stopped: 'day' })
    const out = await registry.matcher(ctx())
    expect(out.output).toMatchObject({ matches: [], skippedReason: 'day-allowance-used', candidatesConsidered: 1 })
  })

  it('does nothing and says so when nothing waits', async () => {
    judge.nextWaiting.mockResolvedValue([])
    const out = await registry.matcher(ctx())
    expect(judge.judgeRoles).not.toHaveBeenCalled()
    expect(out.output).toMatchObject({ matches: [], skippedReason: 'no-candidates', candidatesConsidered: 0 })
  })
})
