import { describe, expect, it } from 'vitest'
import {
  REFRESH_MAX_PER_TURN,
  formatRoleAnswer,
  formatRoleLine,
  pickCompaniesToRefresh,
  placeMatcher,
  titleMatcher,
  type RoleLine,
} from './role-search'

describe('titleMatcher', () => {
  it.each(['FDE', 'forward deployed engineer'])('%s finds forward deployed titles only', (ask) => {
    const m = titleMatcher(ask)!
    expect(m.label).toBe('Forward Deployed Engineer')
    expect(m.matches('Forward Deployed Engineer, Applied AI')).toBe(true)
    expect(m.matches('Solutions Engineer')).toBe(false)
    expect(m.matches('Sales Engineer')).toBe(false)
  })

  it('adjacent titles only when asked, never a sales engineer', () => {
    const m = titleMatcher('FDE', true)!
    expect(m.matches('Solutions Engineer')).toBe(true)
    expect(m.matches('Forward Deployed Engineer')).toBe(true)
    expect(m.matches('Sales Engineer')).toBe(false)
  })

  it('knows the short and long forms of the common titles', () => {
    expect(titleMatcher('ml engineer')!.matches('Machine Learning Engineer')).toBe(true)
    expect(titleMatcher('analytics engineer')!.matches('Analytics Engineer')).toBe(true)
    expect(titleMatcher('analytics engineer')!.matches('Data Engineer')).toBe(false)
    expect(titleMatcher('data scientist')!.matches('Senior Data Scientist')).toBe(true)
  })

  it('matches whole words for a title the map does not know', () => {
    const m = titleMatcher('designer roles')!
    expect(m.keywords).toEqual(['designer'])
    expect(m.matches('Product Designer')).toBe(true)
    expect(m.matches('Undesigned')).toBe(false)
    expect(titleMatcher('  ')).toBeNull()
  })
})

describe('placeMatcher', () => {
  it('SF is San Francisco, not Los Angeles', () => {
    const m = placeMatcher('SF')!
    expect(m.matches('San Francisco, CA | New York City, NY', null)).toBe(true)
    expect(m.matches('Los Angeles, CA', null)).toBe(false)
    expect(m.matches(null, null)).toBe(false)
  })

  it('a state code is a whole word of the location', () => {
    const m = placeMatcher('CA')!
    expect(m.matches('San Francisco, CA', null)).toBe(true)
    expect(m.matches('Cambridge, MA', null)).toBe(false)
  })

  it('remote is the flag or the word', () => {
    const m = placeMatcher('remote')!
    expect(m.matches(null, true)).toBe(true)
    expect(m.matches('Remote - US', null)).toBe(true)
    expect(m.matches('Seattle, WA', false)).toBe(false)
  })

  it('any other place is the text as a whole word', () => {
    const m = placeMatcher('Tokyo')!
    expect(m.matches('Tokyo, Japan', null)).toBe(true)
    expect(m.matches('Tokyoite', null)).toBe(false)
    expect(placeMatcher('')).toBeNull()
  })
})

const NOW = Date.parse('2026-10-06T12:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  career_url: `https://${name}.example/careers`,
  last_scraped_at: null as string | null,
  metadata: null as unknown,
  ...extra,
})

describe('pickCompaniesToRefresh', () => {
  it('skips what was checked in the last 6 hours and picks the rest', () => {
    const r = pickCompaniesToRefresh([row('a', { last_scraped_at: ago(5) }), row('b', { last_scraped_at: ago(7) })], NOW)
    expect(r.pick.map((c) => c.name)).toEqual(['b'])
    expect(r.fresh).toEqual(['a'])
  })

  it('reads a recorded check as a check', () => {
    const metadata = { source_check: { checked_at: ago(1), readable: true } }
    expect(pickCompaniesToRefresh([row('a', { metadata })], NOW).pick).toEqual([])
  })

  it('never checked first, then the oldest', () => {
    const r = pickCompaniesToRefresh(
      [row('old', { last_scraped_at: ago(30) }), row('older', { last_scraped_at: ago(50) }), row('never')],
      NOW
    )
    expect(r.pick.map((c) => c.name)).toEqual(['never', 'older', 'old'])
  })

  it('leaves out suggested companies and those with nothing to read', () => {
    const r = pickCompaniesToRefresh(
      [row('lead', { metadata: { suggested: true } }), row('bare', { career_url: null }), row('ok')],
      NOW
    )
    expect(r.pick.map((c) => c.name)).toEqual(['ok'])
    expect(r.noSource).toEqual(['bare'])
  })

  it('reads at most 5 a turn', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`c${i}`, { last_scraped_at: ago(10 + i) }))
    expect(pickCompaniesToRefresh(rows, NOW).pick).toHaveLength(REFRESH_MAX_PER_TURN)
  })
})

const role = (n: number, company = 'Anthropic'): RoleLine => ({
  title: `Forward Deployed Engineer ${n}`,
  company,
  url: `https://job-boards.greenhouse.io/anthropic/jobs/${n}`,
  location: 'San Francisco, CA',
  postedAt: '2026-09-30T10:00:00Z',
})

describe('formatRoleAnswer', () => {
  const base = { searched: ['Anthropic', 'Stripe', 'Meta'], poolCount: 412, scoped: true, title: 'Forward Deployed Engineer', place: 'SF', notChecked: [] }

  it('says what was searched, one line per role, and where nothing was found', () => {
    const out = formatRoleAnswer({ ...base, roles: [role(1), role(2)], limit: 5 })
    expect(out.split('\n')).toEqual([
      'Searched Anthropic, Stripe and Meta: 412 open roles inside your targets, 2 Forward Deployed Engineer roles in SF.',
      '- [Forward Deployed Engineer 1](https://job-boards.greenhouse.io/anthropic/jobs/1), Anthropic, San Francisco, CA, posted 2026-09-30',
      '- [Forward Deployed Engineer 2](https://job-boards.greenhouse.io/anthropic/jobs/2), Anthropic, San Francisco, CA, posted 2026-09-30',
      'No Forward Deployed Engineer roles in SF at Stripe or Meta. Following another company on [Companies](/companies) brings its board in.',
    ])
  })

  it('prints at most the asked number', () => {
    const out = formatRoleAnswer({ ...base, roles: Array.from({ length: 30 }, (_, i) => role(i)), limit: 25 })
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(25)
    expect(out).not.toContain('No Forward')
  })

  it('zero roles is line one and the no line', () => {
    const out = formatRoleAnswer({ ...base, roles: [], limit: 5, notChecked: ['Meta'] })
    expect(out.split('\n')).toEqual([
      'Searched Anthropic, Stripe and Meta: 412 open roles inside your targets, 0 Forward Deployed Engineer roles in SF.',
      'No Forward Deployed Engineer roles in SF at Anthropic, Stripe or Meta. Following another company on [Companies](/companies) brings its board in.',
      'Not checked in the last 6 hours: Meta.',
    ])
  })

  it('names up to five companies, then a count', () => {
    const out = formatRoleAnswer({ ...base, searched: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], roles: [], limit: 5 })
    expect(out).toContain('Searched A, B, C, D, E and 2 more:')
  })

  it('flags roles outside the targets and fills in what is missing', () => {
    expect(formatRoleLine({ title: 'FDE', company: 'Meta', url: null, location: null, isRemote: true, postedAt: null, insideTargets: false })).toBe(
      '- FDE, Meta, Remote, undated, outside your targets'
    )
    expect(formatRoleLine({ title: 'FDE', company: 'Meta', url: null, location: null, postedAt: null })).toBe('- FDE, Meta, place not listed, undated')
  })

  it('says so when nothing is followed', () => {
    expect(formatRoleAnswer({ ...base, searched: [], roles: [], limit: 5 })).toContain('[Companies](/companies)')
  })

  it('has no em dash, exclamation mark, offer or the word receipt', () => {
    const out = [
      formatRoleAnswer({ ...base, roles: [], limit: 5, notChecked: ['Meta'] }),
      formatRoleAnswer({ ...base, searched: [], roles: [], limit: 5 }),
      formatRoleAnswer({ ...base, roles: [role(1)], limit: 5 }),
    ].join('\n')
    expect(out).not.toMatch(/—|!|want me to|receipt/i)
  })
})
