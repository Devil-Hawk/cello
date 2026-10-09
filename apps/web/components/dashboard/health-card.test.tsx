// renderToStaticMarkup, not a DOM renderer: no jsdom is configured in vitest.config.ts, so the
// fetch wrapper is covered by the route test (a 404 for everyone but the owner) and this file
// pins what the card says in each state.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { HealthCard } from './health-card'
import type { HealthReport } from '@/lib/quality/health'

const MB = 1024 * 1024
const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  checked_at: '2026-10-06T08:00:00Z',
  db_bytes: 212 * MB,
  tables: [],
  schedules: [],
  sources: [],
  issues: [],
  ...over,
})
const render = (r: HealthReport | null | undefined) => renderToStaticMarkup(createElement(HealthCard, { report: r }))

describe('HealthCard', () => {
  it('says no check has run yet when there is no report', () => {
    expect(render(null)).toContain('No health check has run yet. It runs once a day.')
  })

  it('shows the size against the warning line and the day it ran', () => {
    const html = render(report())
    expect(html).toContain('212 MB')
    expect(html).toContain('of 350 MB')
    expect(html).toContain('Last ran Oct 6, 2026')
    expect(html).toContain('Nothing needs your attention.')
    expect(html).toContain('role="progressbar"')
  })

  it('lists each issue with its next step', () => {
    const html = render(
      report({
        db_bytes: 360 * MB,
        issues: [{ kind: 'db_size', subject: 'database', text: 'The database is at 360 MB, past the 350 MB line', next: 'Remove old jobs in Settings or move to a larger plan.' }],
      })
    )
    expect(html).toContain('The database is at 360 MB, past the 350 MB line')
    expect(html).toContain('Remove old jobs in Settings')
    expect(html).not.toContain('Nothing needs your attention.')
  })

  it('says the size cannot be read instead of showing 0', () => {
    const html = render(report({ db_bytes: null }))
    expect(html).toContain('The database size cannot be read.')
    expect(html).not.toContain('0 MB')
  })

  it('renders nothing when the report is unavailable to this person', () => {
    expect(render(undefined)).toBe('')
  })
})
