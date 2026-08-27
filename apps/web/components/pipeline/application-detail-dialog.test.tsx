// What this tests: ActivityTimeline, the pure/presentational piece of the
// activity fetch wired into DialogBody — the real conversation history
// (see app/api/applications/activities/route.ts) rendered newest-first with
// no reordering of its own, and a genuinely empty timeline rendering no
// section at all (the receipts block already carries the honest "nothing
// on file" copy — see this component's own header comment).
//
// renderToStaticMarkup, no jsdom — same approach as draft-card.test.tsx:
// ActivityTimeline takes already-loaded activities as a prop, so there is
// no fetch/useEffect to drive.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ActivityTimeline } from './application-detail-dialog'
import type { ApplicationActivity } from '@/lib/applications/types'

function activity(over: Partial<ApplicationActivity> & { id: string }): ApplicationActivity {
  return {
    application_id: 'app-1',
    type: 'applied',
    title: 'Application submitted',
    description: null,
    metadata: null,
    occurred_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

const FIXTURE: ApplicationActivity[] = [
  activity({ id: 'a1', type: 'applied', title: 'Application submitted', description: 'Applied via careers page.', occurred_at: '2026-08-01T00:00:00.000Z' }),
  activity({ id: 'a2', type: 'recruiter_screen', title: 'Recruiter screen', description: '30 minutes with the recruiting partner.', occurred_at: '2026-08-05T00:00:00.000Z' }),
  activity({ id: 'a3', type: 'interview_loop', title: 'Onsite loop', description: 'Four rounds.', occurred_at: '2026-08-10T00:00:00.000Z' }),
  activity({ id: 'a4', type: 'email_reply', title: 'Reply from recruiting', description: 'Asked two screening questions.', occurred_at: '2026-08-12T00:00:00.000Z' }),
  activity({ id: 'a5', type: 'rejected', title: 'Rejected', description: 'Went with another candidate.', occurred_at: '2026-08-14T00:00:00.000Z' }),
]

function render(activities: ApplicationActivity[]): string {
  return renderToStaticMarkup(createElement(ActivityTimeline, { activities }))
}

describe('ActivityTimeline', () => {
  it('renders every fixture activity title', () => {
    const html = render(FIXTURE)
    for (const a of FIXTURE) {
      expect(html).toContain(a.title)
      expect(html).toContain(a.description as string)
    }
  })

  it('renders in whatever order it is given, newest first per the fixture — no client-side reordering', () => {
    const html = render(FIXTURE)
    const positions = FIXTURE.map((a) => html.indexOf(a.title))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('renders no timeline section at all when there are zero activities', () => {
    const html = render([])
    expect(html).toBe('')
    expect(html).not.toContain('Activity')
  })
})
