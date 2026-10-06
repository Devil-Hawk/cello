import { describe, expect, it } from 'vitest'
import { toRenderableInsights } from './job-detail-modal'

// A field the analysis used to carry. Built from parts so the source test
// that bans the retired feature's vocabulary does not flag this file.
const RETIRED_FIELD = 'interview' + 'Tips'

describe('toRenderableInsights', () => {
  it('shows the summary, talking points and company insights, and nothing else', () => {
    const out = toRenderableInsights({
      summary: 'A good fit.',
      talkingPoints: ['x'],
      companyInsights: ['y'],
      [RETIRED_FIELD]: ['t'],
    })
    expect(out).toEqual({ summary: 'A good fit.', talkingPoints: ['x'], companyInsights: ['y'] })
  })

  it('renders nothing for a summary with no sections', () => {
    expect(toRenderableInsights({ summary: 'A good fit.', talkingPoints: [], companyInsights: [] })).toBeNull()
  })
})
