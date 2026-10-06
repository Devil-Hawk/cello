import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fanOut } from './fanout'
import { makeFakeAdmin } from './testing/fake-admin'
import { branchRecorder, finishTask, heartbeat, retitleTask, startHeartbeat, startTask, statusLabel, type TaskScope } from './tasks'

const scope = (admin = makeFakeAdmin()): TaskScope => ({ admin, userId: 'u1', threadId: 't1', conversationId: 'c1', traceId: 'trace-1' })

describe('task rows', () => {
  it('starts a root task as working with a heartbeat', async () => {
    const s = scope()
    const id = await startTask(s, { agent: 'cello', title: 'Find roles' })
    const row = (s.admin as ReturnType<typeof makeFakeAdmin>).tables.agent_tasks[0]
    expect(id).toBe(row?.id)
    expect(row).toMatchObject({ user_id: 'u1', thread_id: 't1', status: 'working', agent: 'cello', parent_id: null, trace_id: 'trace-1' })
    expect(row?.heartbeat_at).toBeTruthy()
  })

  it('finishes with a status, a reason and artifacts', async () => {
    const s = scope()
    const id = await startTask(s, { agent: 'writer', title: 'Cover letter' })
    await finishTask(s.admin, id, { status: 'partial', partialReason: 'budget', summary: 'Drafted, not reviewed.', artifactIds: ['a1'], costUsd: 0.12345 })
    const row = (s.admin as ReturnType<typeof makeFakeAdmin>).tables.agent_tasks[0]
    expect(row).toMatchObject({ status: 'partial', partial_reason: 'budget', summary: 'Drafted, not reviewed.', artifact_ids: ['a1'], cost_usd: 0.1235 })
    expect(row.finished_at).toBeTruthy()
  })

  it('a task waiting for the person is not finished', async () => {
    const s = scope()
    const id = await startTask(s, { agent: 'cello', title: 'x' })
    await finishTask(s.admin, id, { status: 'waiting' })
    expect((s.admin as ReturnType<typeof makeFakeAdmin>).tables.agent_tasks[0].finished_at).toBeNull()
  })

  it('never throws when the table write fails', async () => {
    const broken = { from: () => ({ insert: () => { throw new Error('realtime down') } }) } as never
    expect(await startTask(scope(broken), { agent: 'cello', title: 'x' })).toBeNull()
    await expect(finishTask(broken, null, { status: 'done' })).resolves.toBeUndefined()
    await expect(finishTask(broken, 'id', { status: 'done' })).resolves.toBeUndefined()
  })

  it('retitles and beats', async () => {
    const s = scope()
    const id = await startTask(s, { agent: 'researcher', title: 'Researching 6 companies' })
    await retitleTask(s.admin, id, 'Researching 6 companies (4 done, 1 partial, 1 failed)')
    expect((s.admin as ReturnType<typeof makeFakeAdmin>).tables.agent_tasks[0].title).toContain('4 done')
    expect(await heartbeat(s.admin, id)).toBe(true)
    expect(await heartbeat(s.admin, null)).toBe(false)
  })
})

describe('heartbeat timer', () => {
  // Only the interval is faked: the in-memory admin yields through setImmediate.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('beats until stopped and runs the side effect each time', async () => {
    const s = scope()
    const id = await startTask(s, { agent: 'cello', title: 'x' })
    const renew = vi.fn(async () => undefined)
    const stop = startHeartbeat(s.admin, id, renew, 1000)
    await vi.advanceTimersByTimeAsync(3100)
    expect(renew).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(renew).toHaveBeenCalledTimes(3)
  })
})

describe('branch rows', () => {
  it('a fan-out writes one child row per branch with ok, partial and failed', async () => {
    const s = scope()
    const parent = await startTask(s, { agent: 'researcher', title: 'Researching 3 companies' })
    await fanOut({
      items: ['Stripe', 'Acme', 'Globex'],
      caps: { steps: 8, ms: 5000, tokens: 20000 },
      deadlineAt: Date.now() + 60_000,
      onBranch: branchRecorder(s, parent, 'researcher', (name) => `Researching ${name}`),
      worker: async (name) => {
        if (name === 'Acme') throw new Error('Site did not load')
        if (name === 'Globex') throw Object.assign(new Error('x'), { name: 'BudgetCapError' })
        return name
      },
    })
    const rows = (s.admin as ReturnType<typeof makeFakeAdmin>).tables.agent_tasks.filter((r) => r.parent_id === parent)
    expect(rows).toHaveLength(3)
    const byTitle = Object.fromEntries(rows.map((r) => [r.title as string, r]))
    expect(byTitle['Researching Stripe']).toMatchObject({ status: 'done', branch_index: 0 })
    expect(byTitle['Researching Acme']).toMatchObject({ status: 'failed', summary: 'Site did not load' })
    expect(byTitle['Researching Globex']).toMatchObject({ status: 'partial', partial_reason: 'budget' })
  })
})

describe('labels', () => {
  it('uses the words the product uses', () => {
    expect(statusLabel('working')).toBe('Working')
    expect(statusLabel('done')).toBe('Done')
    expect(statusLabel('partial', 'budget')).toBe('Partial: ran out of budget')
    expect(statusLabel('partial', 'time')).toBe('Partial: ran out of time')
    expect(statusLabel('partial', 'steps')).toBe('Partial: stopped at its limit')
    expect(statusLabel('failed', null, 'site did not load')).toBe('Failed: site did not load')
    expect(statusLabel('waiting')).toBe('Waiting for your approval')
  })
})
