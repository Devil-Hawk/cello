// Tests for lib/evals/verdicts.ts — the eval_verdicts read/write surface.
// ZERO network: `admin` is a tiny hand-rolled fake capturing whatever an
// insert/select was asked to do, same style as lib/trace/spans.test.ts.
//
// What matters here: writeVerdict is best-effort (logs via logApiError,
// never throws — REFUSE-OVER-GUESS is about the VERDICT being typed, not
// about this bookkeeping write being infallible), picks up span_id only when
// a trace context is active, and readVerdicts throws on a query failure
// (the opposite contract, on purpose — see the file's own header comment).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminClient } from '../harness/types'
import { runInTraceContext, SpanBuffer } from '../trace/spans'

const logApiErrorMock = vi.fn()
vi.mock('../observability/log', () => ({
  logApiError: (...args: unknown[]) => logApiErrorMock(...args),
}))

import { writeVerdict, readVerdicts } from './verdicts'

function makeAdmin(insertResult: { error: { message: string } | null } = { error: null }) {
  const insertCalls: Record<string, unknown>[] = []
  let selectQuery: { table: string; filters: Array<[string, unknown]> } | null = null
  let selectResult: { data: unknown[]; error: { message: string } | null } = { data: [], error: null }
  const admin = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        insertCalls.push(row)
        return insertResult
      },
      select: () => {
        selectQuery = { table, filters: [] }
        const chain = {
          eq: (col: string, val: unknown) => {
            selectQuery!.filters.push([col, val])
            return chain
          },
          order: async () => selectResult,
        }
        return chain
      },
    }),
  } as unknown as AdminClient
  return {
    admin,
    insertCalls,
    getSelectQuery: () => selectQuery,
    setSelectResult: (r: typeof selectResult) => {
      selectResult = r
    },
  }
}

const baseInput = {
  userId: 'user-1',
  subjectKind: 'outreach_draft' as const,
  subjectId: 'msg-1',
  judge: 'factuality' as const,
  verdict: 'pass' as const,
  score: 0.9,
  threshold: 0.5,
  rationale: 'fully grounded',
  model: 'anthropic/claude-haiku-4.5',
}

beforeEach(() => {
  logApiErrorMock.mockReset()
})

describe('writeVerdict', () => {
  it('inserts the row shaped to the eval_verdicts columns, with no span_id outside a trace context', async () => {
    const { admin, insertCalls } = makeAdmin()
    await writeVerdict(admin, baseInput)

    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]).toMatchObject({
      user_id: 'user-1',
      run_id: null,
      span_id: null,
      subject_kind: 'outreach_draft',
      subject_id: 'msg-1',
      judge: 'factuality',
      verdict: 'pass',
      score: 0.9,
      threshold: 0.5,
      rationale: 'fully grounded',
      model: 'anthropic/claude-haiku-4.5',
    })
    expect(logApiErrorMock).not.toHaveBeenCalled()
  })

  it('links span_id from the active trace context, for free, when one is active', async () => {
    const { admin, insertCalls } = makeAdmin()
    await runInTraceContext({ buffer: new SpanBuffer('user-1'), parentSpanId: 'span-77', runId: 'run-1' }, () =>
      writeVerdict(admin, baseInput)
    )

    expect(insertCalls[0]).toMatchObject({ span_id: 'span-77' })
  })

  it('a refusal verdict carries no substituted score', async () => {
    const { admin, insertCalls } = makeAdmin()
    await writeVerdict(admin, {
      userId: 'user-1',
      subjectKind: 'outreach_draft',
      subjectId: 'msg-1',
      judge: 'factuality',
      verdict: 'insufficient-budget',
      rationale: 'Monthly cap reached',
    })

    expect(insertCalls[0]).toMatchObject({ verdict: 'insufficient-budget', score: null })
  })

  it('logs via logApiError and never throws when the insert fails', async () => {
    const { admin } = makeAdmin({ error: { message: 'constraint violation' } })

    await expect(writeVerdict(admin, baseInput)).resolves.toBeUndefined()

    expect(logApiErrorMock).toHaveBeenCalledTimes(1)
    const [route, err, extra] = logApiErrorMock.mock.calls[0] as [string, Error, Record<string, unknown>]
    expect(route).toBe('eval_verdicts:write')
    expect(err.message).toContain('constraint violation')
    expect(extra).toMatchObject({ userId: 'user-1', subjectKind: 'outreach_draft', judge: 'factuality' })
  })
})

describe('readVerdicts', () => {
  it('scopes the query to userId + subjectKind + subjectId, newest first', async () => {
    const { admin, getSelectQuery, setSelectResult } = makeAdmin()
    const rows = [{ id: 'v-1' }, { id: 'v-2' }]
    setSelectResult({ data: rows, error: null })

    const result = await readVerdicts(admin, {
      userId: 'user-1',
      subjectKind: 'outreach_draft',
      subjectId: 'msg-1',
    })

    expect(result).toEqual(rows)
    expect(getSelectQuery()).toMatchObject({
      table: 'eval_verdicts',
      filters: [
        ['user_id', 'user-1'],
        ['subject_kind', 'outreach_draft'],
        ['subject_id', 'msg-1'],
      ],
    })
  })

  it('throws — unlike writeVerdict — when the query fails', async () => {
    const { admin, setSelectResult } = makeAdmin()
    setSelectResult({ data: [], error: { message: 'connection reset' } })

    await expect(
      readVerdicts(admin, { userId: 'user-1', subjectKind: 'outreach_draft', subjectId: 'msg-1' })
    ).rejects.toThrow('connection reset')
  })

  it('returns an empty array, not null, when there are no rows', async () => {
    const { admin, setSelectResult } = makeAdmin()
    setSelectResult({ data: [], error: null })

    const result = await readVerdicts(admin, {
      userId: 'user-1',
      subjectKind: 'outreach_draft',
      subjectId: 'msg-1',
    })
    expect(result).toEqual([])
  })
})
