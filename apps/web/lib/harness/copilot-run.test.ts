import { describe, expect, it } from 'vitest'
import { COPILOT_RUN_MARKER, isCopilotRun, withoutSourcer } from './copilot-run'
import type { Plan } from './types'

const plan: Plan = {
  goal: 'keep sourcing and drafting applications',
  steps: [
    { label: 'source-jobs', agent_type: 'sourcer', input: {}, dependsOn: [] },
    { label: 'score-jobs', agent_type: 'matcher', input: {}, dependsOn: ['source-jobs'] },
    { label: 'enrich-top', agent_type: 'enricher', input: {}, dependsOn: ['score-jobs'] },
  ],
}

describe('withoutSourcer', () => {
  it('drops sourcer steps and the dependencies on them, keeping the rest in order', () => {
    const out = withoutSourcer(plan)
    expect(out.steps.map((s) => s.label)).toEqual(['score-jobs', 'enrich-top'])
    expect(out.steps[0]!.dependsOn).toEqual([])
    expect(out.steps[1]!.dependsOn).toEqual(['score-jobs'])
  })

  it('leaves a plan with no sourcer untouched', () => {
    const clean = withoutSourcer(plan)
    expect(withoutSourcer(clean)).toBe(clean)
  })
})

describe('isCopilotRun', () => {
  it('reads the marker and nothing else', () => {
    expect(isCopilotRun(COPILOT_RUN_MARKER)).toBe(true)
    expect(isCopilotRun(null)).toBe(false)
    expect(isCopilotRun({ status: 'completed' })).toBe(false)
  })
})
