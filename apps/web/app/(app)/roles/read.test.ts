import { describe, expect, it } from 'vitest'
import { parseRolesQuery } from '@/components/roles/logic'
import { TYPE_OPTIONS, filtered, typeOptionsFor } from './read'

/** A query builder that records every filter call and returns itself. */
function recorder() {
  const calls: [string, unknown[]][] = []
  const b: unknown = new Proxy(
    {},
    {
      get: (_t, method: string) => (...args: unknown[]) => {
        calls.push([method, args])
        return b
      },
    },
  )
  return { db: { from: () => b } as never, calls }
}
const has = (calls: [string, unknown[]][], method: string, ...args: unknown[]) => calls.some(([m, a]) => m === method && args.every((x, i) => a[i] === x))

describe('the role type choices', () => {
  it("put the person's own role types first, in their order, then the rest", () => {
    const [a, b] = TYPE_OPTIONS.slice(-2).map((o) => o.id)
    const options = typeOptionsFor({ targeting: { role_types: [b, a] } })
    expect(options.slice(0, 2).map((o) => o.id)).toEqual([b, a])
    expect(options).toHaveLength(TYPE_OPTIONS.length)
    expect(new Set(options.map((o) => o.id)).size).toBe(TYPE_OPTIONS.length)
  })

  it('stay as they are for a person with no types chosen', () => {
    expect(typeOptionsFor(null)).toEqual(TYPE_OPTIONS)
  })
})

describe('the Roles filters, as the list asks for them', () => {
  it('filters on the posting language', () => {
    const { db, calls } = recorder()
    filtered(db, parseRolesQuery({ lang: 'de' }), null)
    expect(has(calls, 'eq', 'jobs.language', 'de')).toBe(true)
  })

  it("filters on the person's own chance band, and not at all without one", () => {
    const on = recorder()
    filtered(on.db, parseRolesQuery({ chance: 'strong' }), null)
    expect(has(on.calls, 'eq', 'chance', 'strong')).toBe(true)
    const off = recorder()
    filtered(off.db, parseRolesQuery({}), null)
    expect(off.calls.some(([, a]) => a[0] === 'chance')).toBe(false)
  })

  it('filters on postings whose text mentions sponsorship', () => {
    const { db, calls } = recorder()
    filtered(db, parseRolesQuery({ sponsor: '1' }), null)
    expect(calls.some(([m, a]) => m === 'or' && String(a[0]).includes('description.ilike.*sponsor*') && String(a[0]).includes('description_md.ilike.*sponsor*'))).toBe(true)
  })

  it('asks for none of them by default', () => {
    const { db, calls } = recorder()
    filtered(db, parseRolesQuery({}), null)
    expect(has(calls, 'eq', 'jobs.language')).toBe(false)
    expect(calls.some(([, a]) => String(a[0]).includes('sponsor'))).toBe(false)
  })
})
