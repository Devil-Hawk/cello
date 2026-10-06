// The Writer's review as the route-facing one: a reader that could not run is never shown as a pass.

import { describe, expect, it } from 'vitest'
import type { WriterResult } from '@/lib/workflows/writer'
import { asOutreachReview } from './write'

const out = (judge: NonNullable<WriterResult['review']>['judge'], over: Partial<WriterResult> = {}): WriterResult => ({
  status: 'ok',
  review: { passed: true, issues: [], checks: [{ name: 'one ask', ok: true }], judge, checked_by: 'x' },
  ...over,
})

describe('asOutreachReview', () => {
  it('a passed reader is a groundedness verdict and the checks keep their ids', () => {
    const r = asOutreachReview(out({ status: 'passed' }), 'S', 'B')
    expect(r.verdicts).toMatchObject([{ name: 'groundedness', verdict: 'pass' }])
    expect(r.checks).toEqual({ ok: true, checks: [{ id: 'one ask', ok: true, message: 'one ask' }] })
    expect(r).toMatchObject({ subject: 'S', body: 'B', source: 'model', failed: false, judgeUnavailable: false })
  })

  it('a failed reader is a failed verdict and the draft is marked failed', () => {
    const r = asOutreachReview(out({ status: 'failed' }, { review: { passed: false, issues: ['A second reader found statements the resume and the role do not support.'], checks: [], judge: { status: 'failed' }, checked_by: 'x' } }), 'S', 'B')
    expect(r.verdicts).toMatchObject([{ verdict: 'fail', score: 0 }])
    expect(r.failed).toBe(true)
  })

  it.each([
    ['No key for the second opinion.', 'missing-key', false],
    ['Budget reached before the second opinion.', 'budget-cap', false],
    ['The second opinion was not available.', undefined, true],
  ])('a skipped reader (%s) writes no verdict and says why', (reason, refused, unavailable) => {
    const r = asOutreachReview(out({ status: 'skipped', reason }), 'S', 'B')
    expect(r.verdicts).toEqual([])
    expect(r.judgeRefused).toBe(refused)
    expect(r.judgeUnavailable).toBe(unavailable)
  })

  it('a template carries its reason', () => {
    const r = asOutreachReview(out({ status: 'skipped', reason: 'No key for the second opinion.' }, { used_llm: false, template_reason: 'missing_key' }), 'S', 'B')
    expect(r).toMatchObject({ source: 'template', templateReason: 'missing_key' })
  })
})
