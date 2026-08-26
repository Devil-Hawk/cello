// lib/a2a/task-store.ts — the two invariants spec Step 3 names explicitly:
//   6. "thread ownership (task of user A polled with user B's token ->
//      refusal)"
//   3. "tasks/get polls: non-terminal -> invokeGraphForUser({kind:
//      'continue'}) then report state"
// plus the load-bearing guard load()'s own header names: no continue
// attempt before the thread has ever actually started (started_at===null),
// and none once a2a_tasks itself already says 'cancelled'.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TaskState } from '@a2a-js/sdk'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import { createA2aTaskStore } from './task-store'
import { STATE_USER_ID_KEY } from './context'

const invokeGraphForUserMock = vi.fn(async (..._args: unknown[]) => ({ threadId: 'thread-1', result: {} }))
vi.mock('@/lib/graph/invoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/invoke')>()
  return { ...actual, invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args) }
})
// task-store.ts imports via a relative path ('../graph/invoke'), not the
// '@/...' alias — mock both specifiers so whichever resolution Vitest uses
// for THIS file's import graph is covered.
vi.mock('../graph/invoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graph/invoke')>()
  return { ...actual, invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args) }
})

function ctx(userId: string | undefined): ServerCallContext {
  return { state: new Map(userId ? [[STATE_USER_ID_KEY, userId]] : []) } as unknown as ServerCallContext
}

interface Rows {
  a2aTasks: Map<string, Record<string, unknown>>
  agentRuns: Map<string, Record<string, unknown>>
}

function fakeAdmin(rows: Rows) {
  return {
    from(table: string) {
      if (table === 'a2a_tasks') {
        return {
          select: () => ({
            eq: (_col: string, taskId: string) => ({
              maybeSingle: async () => ({ data: rows.a2aTasks.get(taskId) ?? null, error: null }),
            }),
          }),
          update: (fields: Record<string, unknown>) => ({
            eq: async (_col: string, taskId: string) => {
              const existing = rows.a2aTasks.get(taskId)
              if (existing) rows.a2aTasks.set(taskId, { ...existing, ...fields })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'agent_runs') {
        return {
          select: () => ({
            eq: (col: string, value: string) => ({
              maybeSingle: async () => {
                const row = [...rows.agentRuns.values()].find((r) => (r as Record<string, unknown>)[col] === value)
                return { data: row ?? null, error: null }
              },
            }),
          }),
        }
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`)
    },
  } as unknown as import('@/lib/harness/types').AdminClient
}

beforeEach(() => {
  invokeGraphForUserMock.mockClear()
  invokeGraphForUserMock.mockImplementation(async () => ({ threadId: 'thread-1', result: {} }))
})

describe('ownership: a task of user A polled with user B\'s context refuses', () => {
  it('returns undefined (indistinguishable from not-found — same doctrine as loadOwnedThread)', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'submitted' }]]),
      agentRuns: new Map([['run-1', { id: 'run-1', thread_id: 'thread-1', status: 'queued', started_at: null, result: null, error: null }]]),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    const task = await store.load('task-1', ctx('user-B'))
    expect(task).toBeUndefined()
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })

  it('returns undefined with no context user at all', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'submitted' }]]),
      agentRuns: new Map(),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    expect(await store.load('task-1', ctx(undefined))).toBeUndefined()
  })
})

describe('non-terminal poll advances the run; terminal/cancelled never does', () => {
  it('a non-terminal run that already started calls invokeGraphForUser (continue) exactly once', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'working' }]]),
      agentRuns: new Map([['run-1', { id: 'run-1', thread_id: 'thread-1', status: 'running', started_at: '2026-08-25T00:00:00Z', result: null, error: null }]]),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    const task = await store.load('task-1', ctx('user-A'))
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0]![0] as { threadId: string; input?: unknown; resume?: unknown }
    expect(call.threadId).toBe('thread-1')
    expect(call.input).toBeUndefined() // THE RESUME RULE's "continue" shape: no input, no resume
    expect(call.resume).toBeUndefined()
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })

  it('does NOT continue a thread that has never actually started (started_at===null) — avoids racing message/send\'s own kickoff', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'submitted' }]]),
      agentRuns: new Map([['run-1', { id: 'run-1', thread_id: 'thread-1', status: 'queued', started_at: null, result: null, error: null }]]),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    const task = await store.load('task-1', ctx('user-A'))
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED)
  })

  it('does not continue a completed run', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'working' }]]),
      agentRuns: new Map([
        [
          'run-1',
          { id: 'run-1', thread_id: 'thread-1', status: 'completed', started_at: '2026-08-25T00:00:00Z', result: { outputs: { run: { matches: [] } } }, error: null },
        ],
      ]),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    const task = await store.load('task-1', ctx('user-A'))
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(task?.artifacts).toHaveLength(1)
  })

  it('a task already marked cancelled never resumes again, even if agent_runs still looks in-flight (tasks/cancel: "stop resuming")', async () => {
    const rows: Rows = {
      a2aTasks: new Map([['task-1', { task_id: 'task-1', user_id: 'user-A', thread_id: 'thread-1', agent: 'matcher', status: 'cancelled' }]]),
      agentRuns: new Map([['run-1', { id: 'run-1', thread_id: 'thread-1', status: 'running', started_at: '2026-08-25T00:00:00Z', result: null, error: null }]]),
    }
    const store = createA2aTaskStore(fakeAdmin(rows))
    const task = await store.load('task-1', ctx('user-A'))
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
    // Reports whatever a2a_tasks/agent_runs currently reflect (still
    // 'running' in agent_runs since nothing here rewrites that column) —
    // the guarantee is "never resumes again", not "instantly shows canceled"
    // if the underlying run happened to reach a checkpoint on its own.
    expect(task?.status?.state).toBe(TaskState.TASK_STATE_WORKING)
  })
})
