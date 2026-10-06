// Where your roles come from and how your roles spread: hand counts over fixture kept roles. Each role is counted
// once, empty groups are not listed, and See them appears only where Roles can filter.

import { describe, expect, it } from 'vitest'
import { sourceGroups, spreadGroups, type Followed, type KeptRole } from './results'

const role = (job: Partial<NonNullable<KeptRole['jobs']>>, chance: string | null = null): KeptRole => ({ chance, jobs: { employer_id: null, company_id: null, source: 'greenhouse', source_tier: 'board', ...job } })
const followed: Followed = { employers: new Set(['e1']), companies: new Set(['c9']) }

describe('sourceGroups', () => {
  it('counts each kept role once, followed first, then the rest by how they were traced', () => {
    const rows = [
      role({ employer_id: 'e1' }), // followed, by directory employer
      role({ company_id: 'c9' }), // followed, by the person's own company row
      role({ employer_id: 'e2' }), // directory
      role({ employer_id: 'e2' }),
      role({ employer_id: 'e3', source: 'adzuna', source_tier: 'listing' }), // a board traced to the employer
      role({ source: 'manual' }), // pasted
      role({ source: 'adzuna', source_tier: 'listing' }), // not traced
    ]
    const g = sourceGroups(rows, followed)
    expect(g.map((x) => [x.id, x.n])).toEqual([['followed', 2], ['directory', 2], ['traced', 1], ['pasted', 1], ['untraced', 1]])
    expect(g.reduce((s, x) => s + x.n, 0)).toBe(rows.length)
  })

  it('offers See them only for the followed group, which Roles can filter by', () => {
    const g = sourceGroups([role({ employer_id: 'e1' }), role({})], followed)
    expect(g.find((x) => x.id === 'followed')?.href).toBe('/roles?following=1')
    expect(g.find((x) => x.id === 'untraced')?.href).toBeNull()
  })

  it('lists no group with no roles', () => {
    expect(sourceGroups([], followed)).toEqual([])
    expect(sourceGroups([role({})], followed).map((x) => x.id)).toEqual(['untraced'])
  })

  it('a role with no posting row is not traced', () => {
    expect(sourceGroups([{ chance: null, jobs: null }], followed).map((x) => x.id)).toEqual(['untraced'])
  })
})

describe('spreadGroups', () => {
  it('counts by Cello\'s call on the chance, and the roles not checked yet, each opening Roles filtered where it can', () => {
    const rows = [role({}, 'strong'), role({}, 'strong'), role({}, 'possible'), role({}, 'stretch'), role({}, null), role({}, 'cannot_assess')]
    const g = spreadGroups(rows)
    expect(g.map((x) => [x.id, x.n, x.href])).toEqual([['strong', 2, '/roles?chance=strong'], ['possible', 1, '/roles?chance=possible'], ['stretch', 1, '/roles?chance=stretch'], ['unchecked', 2, null]])
  })

  it('lists nothing for no roles, never a chart of zeros', () => {
    expect(spreadGroups([])).toEqual([])
  })
})
