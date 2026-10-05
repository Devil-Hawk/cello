import { describe, expect, it } from 'vitest'
import { toRenderableInsights } from './job-detail-modal'

describe('toRenderableInsights', () => {
  it('shows the summary, talking points and company insights, and nothing else', () => {
    const out = toRenderableInsights({
      summary: 'A good fit.',
      talkingPoints: ['x'],
      companyInsights: ['y'],
      interviewTips: ['t'],
    })
    expect(out).toEqual({ summary: 'A good fit.', talkingPoints: ['x'], companyInsights: ['y'] })
  })

  it('renders nothing for a summary with no sections', () => {
    expect(toRenderableInsights({ summary: 'A good fit.', talkingPoints: [], companyInsights: [] })).toBeNull()
  })
})
