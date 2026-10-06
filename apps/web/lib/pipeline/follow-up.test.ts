import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_TIMING, followUpStep } from './follow-up'
import { getPipelineAlert, type ApplicationWithJob } from '@/components/pipeline/utils'
import { buildDemoWorkspace } from '@/lib/access/seed-demo'

const NOW = Date.parse('2026-08-03T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (n: number) => new Date(NOW - n * DAY)

describe('followUpStep', () => {
  it('is due from the stage minimum on, at every stage', () => {
    for (const [stage, { min }] of Object.entries(FOLLOW_UP_TIMING)) {
      expect(followUpStep(stage, ago(min - 1), NOW).due).toBe(false)
      expect(followUpStep(stage, ago(min), NOW).due).toBe(true)
    }
  })

  it('keeps the same copy past the maximum', () => {
    const inWindow = followUpStep('screen', ago(5), NOW)
    expect(inWindow.suggestion).toContain('5 days')
    expect(inWindow.suggestion.toLowerCase()).toContain('thank you note')
    expect(followUpStep('screen', ago(9), NOW).suggestion).toContain('9 days')
  })

  it('says it is too soon before the minimum, with the day to wait for', () => {
    const r = followUpStep('screen', ago(2), NOW)
    expect(r).toMatchObject({ due: false, days: 2 })
    expect(r.suggestion).toContain('too soon')
    expect(r.suggestion).toContain('day 3')
  })

  it('treats an application never marked applied as not yet due', () => {
    const r = followUpStep('applied', null, NOW)
    expect(r.due).toBe(false)
    expect(r.suggestion).toContain('too soon')
  })

  it('has no follow-up outside the follow-up stages', () => {
    const r = followUpStep('rejected', ago(30), NOW)
    expect(r).toMatchObject({ due: false, suggestion: 'No follow-up action needed at this stage.' })
  })

  it('gives offer its own copy', () => {
    expect(followUpStep('offer', ago(3), NOW).suggestion.toLowerCase()).toContain('offer')
  })

  it('still suggests a follow-up on the demo workspace', () => {
    const now = new Date(NOW)
    const { batches } = buildDemoWorkspace('11111111-2222-4333-8444-555555555555', now)
    const rows = batches.find((b) => b.table === 'applications')!.rows as {
      stage: string
      applied_at: string | null
    }[]
    const due = rows
      .map((r) => followUpStep(r.stage, r.applied_at ? new Date(r.applied_at) : null, NOW))
      .filter((r) => r.due)
    expect(due.length).toBeGreaterThan(0)
    for (const r of due) expect(r.suggestion.length).toBeGreaterThan(0)
  })
})

describe('getPipelineAlert reads the same table', () => {
  it('flags Follow up at applied day 5', () => {
    const updated = new Date(Date.now() - 5 * DAY).toISOString()
    const app = { stage: 'applied', updated_at: updated } as ApplicationWithJob
    expect(getPipelineAlert(app)?.label).toBe('Follow up')
  })
})
