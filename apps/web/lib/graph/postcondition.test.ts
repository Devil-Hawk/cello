import { describe, expect, it, vi } from 'vitest'
import { checkToolPostcondition, recordToolPostcondition } from './postcondition'
import * as verdicts from '../evals/verdicts'

describe('checkToolPostcondition', () => {
  it('passes on real output and a sane token counter', () => {
    expect(checkToolPostcondition({ jobId: '1' }, 42)).toEqual({ ok: true, reasons: [] })
  })

  it('fails when output is null/undefined', () => {
    expect(checkToolPostcondition(undefined, 0).ok).toBe(false)
    expect(checkToolPostcondition(null, 0).ok).toBe(false)
  })

  it('fails on a negative or non-finite tokensUsed', () => {
    expect(checkToolPostcondition({}, -1).ok).toBe(false)
    expect(checkToolPostcondition({}, NaN).ok).toBe(false)
  })
})

describe('recordToolPostcondition', () => {
  it('skips writing when the journal upsert already failed (no stepId)', async () => {
    const spy = vi.spyOn(verdicts, 'writeVerdict').mockResolvedValue()
    await recordToolPostcondition({} as never, {
      userId: 'u1',
      runId: 'r1',
      stepId: null,
      check: { ok: true, reasons: [] },
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('writes a tool_call/deterministic verdict keyed on the journaled step id', async () => {
    const spy = vi.spyOn(verdicts, 'writeVerdict').mockResolvedValue()
    await recordToolPostcondition({} as never, {
      userId: 'u1',
      runId: 'r1',
      stepId: 'step-1',
      check: { ok: false, reasons: ['output parsed to null/undefined'] },
    })
    expect(spy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        subjectKind: 'tool_call',
        subjectId: 'step-1',
        judge: 'deterministic',
        verdict: 'fail',
        rationale: 'output parsed to null/undefined',
      })
    )
    spy.mockRestore()
  })
})
