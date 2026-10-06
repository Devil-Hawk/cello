// Applications: every fixture row in exactly one group, the list and the board from one application list, Move to
// on each board card, a 60 character title beside its company untruncated, filters, and the order of the groups.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { groupOf } from '@/lib/pipeline/groups'
import { ApplicationsView, GROUPS, applyFilters, groupRows, NO_FILTERS, type AppRow } from './applications-view'

const LONG = 'Staff Machine Learning Engineer, Applied Research and Platform'

const row = (i: number, over: Partial<AppRow> = {}): AppRow => {
  const r: AppRow = {
    id: `a${i}`,
    job_id: `j${i}`,
    stage: 'applied',
    state: 'sent',
    step: null,
    needs_reason: null,
    needs_detail: null,
    applied_at: '2026-03-04T10:00:00Z',
    last_event_at: '2026-03-05T10:00:00Z',
    created_at: '2026-03-01T10:00:00Z',
    source: 'manual',
    closed_reason: null,
    cost_usd: null,
    found_state: null,
    group: null,
    jobs: { title: `Role ${i}`, url: null, companies: { name: `Company ${i % 3}` } },
    ...over,
  }
  return { ...r, group: groupOf(r as never, null) }
}

const fixture: AppRow[] = [
  row(1, { state: 'ready', stage: 'discovered' }),
  row(2, { state: 'needs_you', needs_reason: 'approve_resume', stage: 'discovered' }),
  row(3, { state: 'preparing', step: 'Reading the posting', stage: 'discovered' }),
  row(4, { state: 'paused', stage: 'discovered' }),
  row(5, { state: 'sent', stage: 'applied' }),
  row(6, { state: 'confirmed', stage: 'applied' }),
  row(7, { state: 'sent', stage: 'interview' }),
  row(8, { state: 'sent', stage: 'offer' }),
  row(9, { state: 'sent', stage: 'rejected', closed_reason: 'rejected' }),
  row(10, { state: 'skipped', stage: 'discovered', closed_reason: 'skipped' }),
  row(11, { state: null, stage: 'discovered' }), // a saved role: not an application, in no group
  row(12, { state: null, stage: 'applied', found_state: 'to_confirm' }),
]

const html = (props: Partial<Parameters<typeof ApplicationsView>[0]> = {}) => renderToStaticMarkup(<ApplicationsView rows={fixture} onMove={() => undefined} {...props} />).replace(/<!-- -->/g, '')

describe('groups', () => {
  it('puts every application in exactly one group, and a saved role in none', () => {
    const grouped = groupRows(fixture)
    const placed = [...grouped.values()].flat().map((r) => r.id)
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.sort()).toEqual(['a1', 'a10', 'a12', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'].sort())
    expect(placed).not.toContain('a11')
  })

  it('reads in the order Needs you, preparing, waiting, interview and offer, closed', () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['Needs you', 'Cello is preparing', 'Waiting on the employer', 'Interview and offer', 'Closed'])
    const out = html()
    const at = (s: string) => out.indexOf(s)
    expect(at('Needs you')).toBeLessThan(at('Cello is preparing'))
    expect(at('Cello is preparing')).toBeLessThan(at('Waiting on the employer'))
    expect(at('Waiting on the employer')).toBeLessThan(at('Interview and offer'))
    expect(at('Interview and offer')).toBeLessThan(at('Closed ('))
  })

  it('names why a closed one closed and keeps closed ones folded', () => {
    const out = html()
    expect(out).toContain('<details')
    expect(out).toContain('Not selected')
    expect(out).toContain('Skipped')
  })
})

describe('Board and List', () => {
  it('both show every application of the one list, and the board has Move to on each card', () => {
    const list = html({ mode: 'list' })
    const board = html({ mode: 'board' })
    for (const r of fixture.filter((x) => x.group && x.stage !== 'discovered')) {
      expect(list).toContain(`Role ${r.id.slice(1)}`)
      expect(board).toContain(`Role ${r.id.slice(1)}`)
    }
    const cards = fixture.filter((x) => ['applied', 'screen', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted'].includes(x.stage) && x.group)
    expect((board.match(/Move to/g) ?? []).length).toBe(cards.length)
    expect(board).not.toMatch(/Ghosted|Discovered/)
  })
})

describe('a row', () => {
  it('renders a 60 character title whole beside its company, both in the same class', () => {
    expect(LONG.length).toBeGreaterThanOrEqual(60)
    const out = html({ rows: [row(1, { jobs: { title: LONG, url: null, companies: { name: 'Orchid Ledger' } } })] })
    expect(out).toContain(LONG)
    expect(out).not.toMatch(/truncate|line-clamp|text-ellipsis/)
    expect((out.match(/class="r-name/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(out).toContain('href="/roles/j1"')
  })

  it('says one sentence of where it stands and the one button', () => {
    const out = html({ rows: [row(2, { state: 'needs_you', needs_reason: 'approve_resume' })] })
    expect(out).toContain('Needs you: approve the tailored resume.')
    expect(out).toMatch(/<a [^>]*href="\/roles\/j2"[^>]*>Open<\/a>/)
  })
})

describe('filters', () => {
  it('narrow by company, stage, closed reason and month', () => {
    expect(applyFilters(fixture, { ...NO_FILTERS, company: 'Company 1' }).every((r) => r.jobs?.companies?.name === 'Company 1')).toBe(true)
    expect(applyFilters(fixture, { ...NO_FILTERS, stage: 'interview' }).map((r) => r.id)).toEqual(['a7'])
    expect(applyFilters(fixture, { ...NO_FILTERS, closed: 'rejected' }).map((r) => r.id)).toEqual(['a9'])
    expect(applyFilters(fixture, { ...NO_FILTERS, month: '2026-03' }).length).toBeGreaterThan(0)
    expect(applyFilters(fixture, { ...NO_FILTERS, month: '2025-01' })).toEqual([])
  })
})
