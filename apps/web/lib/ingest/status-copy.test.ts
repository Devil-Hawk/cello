import { describe, expect, it } from 'vitest'
import { detailsLines, statusCopy, timeAgo } from './status-copy'
import type { FindNewRolesStatus } from './status'

const NOW = new Date('2026-10-06T14:58:00Z')

function status(over: Partial<FindNewRolesStatus> = {}): FindNewRolesStatus {
  return {
    state: 'done',
    startedAt: '2026-10-06T12:41:00Z',
    finishedAt: '2026-10-06T12:58:00Z',
    companiesChecked: 42,
    companiesTotal: 42,
    jobsNew: 7,
    jobsUpdated: 2,
    jobsClosed: 3,
    failed: [],
    nextCheckAt: '2026-10-06T18:41:00Z',
    hasCompanies: true,
    ...over,
  }
}

// Times print in the machine's zone; pin it so "18:41" is stable.
const CLOCK = new Date('2026-10-06T18:41:00Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

describe('timeAgo', () => {
  it('reads in minutes, hours and days', () => {
    expect(timeAgo('2026-10-06T14:58:00Z', NOW)).toBe('just now')
    expect(timeAgo('2026-10-06T14:57:00Z', NOW)).toBe('1 minute ago')
    expect(timeAgo('2026-10-06T12:58:00Z', NOW)).toBe('2 hours ago')
    expect(timeAgo('2026-10-04T14:58:00Z', NOW)).toBe('2 days ago')
  })
})

describe('statusCopy', () => {
  it('done: how many were checked, what came back, and when the next check is', () => {
    const c = statusCopy(status(), NOW)
    expect(c.long).toBe('Checked 42 companies 2 hours ago: 7 new, 3 closed')
    expect(c.short).toBe('Checked 2h ago: 7 new, 3 closed')
    expect(c.next).toBe(`Next around ${CLOCK}`)
    expect(c.tone).toBe('ink')
    expect(c.details).toBe(false)
  })

  it('done with nothing new says so', () => {
    const c = statusCopy(status({ jobsNew: 0, jobsClosed: 0 }), NOW)
    expect(c.long).toBe('Checked 42 companies 2 hours ago. No new roles.')
    expect(c.short).toBe('Checked 2h ago. No new roles.')
  })

  it('partial: stays ink, not amber and not red, and offers the details', () => {
    const c = statusCopy(status({ state: 'partial', companiesChecked: 38, jobsClosed: 0 }), NOW)
    expect(c.long).toBe('Checked 38 of 42 companies 2 hours ago: 7 new')
    expect(c.tone).toBe('ink')
    expect(c.details).toBe(true)
  })

  it('checking: the drawing scroll and the count', () => {
    const c = statusCopy(status({ state: 'checking', finishedAt: null }), NOW)
    expect(c).toMatchObject({ long: 'Checking 42 companies now', working: true })
  })

  it('failed: red, and says when it tries again', () => {
    const c = statusCopy(status({ state: 'failed' }), NOW)
    expect(c.long).toBe(`The last check did not finish. Cello tries again around ${CLOCK}.`)
    expect(c.tone).toBe('danger')
  })

  it('never: first check time when there are companies, an invitation when there are none', () => {
    expect(statusCopy(status({ state: 'never', hasCompanies: true }), NOW).long).toBe(`First check around ${CLOCK}. You can refresh now.`)
    expect(statusCopy(status({ state: 'never', hasCompanies: false }), NOW).long).toBe(
      'Find new roles checks your companies every 6 hours. Add a company to start.'
    )
  })

  it('says nothing about a next check the clock has not scheduled', () => {
    const none = { nextCheckAt: null }
    expect(statusCopy(status(none), NOW).next).toBeNull()
    expect(statusCopy(status({ ...none, state: 'never' }), NOW).long).toBe('Not checked yet. You can refresh now.')
    expect(statusCopy(status({ ...none, state: 'failed' }), NOW).long).toBe('The last check did not finish.')
    expect(detailsLines(status({ ...none, state: 'partial' }), 1).footer).toBe('These are checked again at the next check.')
  })

  it('never uses engineering words or an em dash', () => {
    const states: FindNewRolesStatus['state'][] = ['never', 'checking', 'done', 'partial', 'failed']
    for (const state of states) {
      const c = statusCopy(status({ state }), NOW)
      for (const line of [c.long, c.short, c.next ?? '']) {
        expect(line).not.toMatch(/\b(run|runs|thread|tick|step|graph|agent|scrape|ingest)\b/i)
        expect(line).not.toContain('—')
        expect(line).not.toContain('!')
      }
    }
  })
})

describe('detailsLines', () => {
  it('lists up to ten companies, then how many more, then when they are checked again', () => {
    const failed = Array.from({ length: 12 }, (_, i) => ({
      companyId: `c${i}`,
      companyName: `Company ${i}`,
      reason: 'board_error' as const,
      text: 'Its job board did not respond',
    }))
    const d = detailsLines(status({ state: 'partial', failed }), 14)
    expect(d.items).toHaveLength(10)
    expect(d.items[0]).toBe('Company 0: Its job board did not respond')
    expect(d.more).toBe('and 4 more')
    expect(d.footer).toBe(`These are checked again around ${CLOCK}.`)
  })
})
