// What this tests: the same ownership guarantee as the receipts route — an
// application belonging to another user is refused exactly like one that
// doesn't exist, never leaking which — and that this user's own activities
// come back newest-first, capped, without another user's rows ever
// appearing just because they share an applicationId lookup path.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface ApplicationFixture {
  id: string
  user_id: string
}

interface ActivityFixture {
  id: string
  application_id: string
  type: string
  title: string
  description: string | null
  metadata: Record<string, unknown> | null
  occurred_at: string
}

let state: {
  user: { id: string } | null
  applications: ApplicationFixture[]
  activities: ActivityFixture[]
}

function activity(over: Partial<ActivityFixture> & { id: string; application_id: string }): ActivityFixture {
  return {
    type: 'applied',
    title: 'Application submitted',
    description: null,
    metadata: null,
    occurred_at: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

/** Chainable query stub, narrow enough for this route's two shapes:
 *  applications' `.eq().eq().maybeSingle()` ownership lookup, and
 *  activities' `.eq().order().limit()` list. */
function chain(table: string) {
  const filters: Record<string, unknown> = {}
  let limitTo: number | null = null
  let orderColumn: string | null = null
  const self: Record<string, unknown> = {
    eq(column: string, value: unknown) {
      filters[column] = value
      return self
    },
    order(column: string) {
      orderColumn = column
      return self
    },
    limit(n: number) {
      limitTo = n
      return self
    },
    maybeSingle: async () => {
      const rows = state.applications.filter((row) =>
        Object.entries(filters).every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val)
      )
      return { data: rows[0] ?? null, error: null }
    },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      let rows = state.activities.filter((row) =>
        Object.entries(filters).every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val)
      )
      if (orderColumn === 'occurred_at') {
        rows = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
      }
      const data = limitTo !== null ? rows.slice(0, limitTo) : rows
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    },
  }
  return self
}

const admin = {
  from(table: string) {
    return { select: () => chain(table) }
  },
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))

import { GET } from './route'

function get(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/applications/activities${query}`)
}

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    applications: [{ id: 'app-1', user_id: 'user-1' }],
    activities: [],
  }
})

describe('GET /api/applications/activities', () => {
  it('refuses a signed-out request', async () => {
    state.user = null
    const response = await GET(get('?applicationId=app-1'))
    expect(response.status).toBe(401)
  })

  it('requires applicationId', async () => {
    const response = await GET(get())
    expect(response.status).toBe(400)
  })

  it("refuses another user's applicationId, identically to a missing one", async () => {
    state.applications = [{ id: 'app-1', user_id: 'someone-else' }]
    const response = await GET(get('?applicationId=app-1'))
    expect(response.status).toBe(404)
  })

  it('404s on an applicationId that does not exist at all', async () => {
    const response = await GET(get('?applicationId=nope'))
    expect(response.status).toBe(404)
  })

  it("returns this user's activities newest-first", async () => {
    state.activities = [
      activity({ id: 'a1', application_id: 'app-1', title: 'Applied', occurred_at: '2026-08-01T00:00:00.000Z' }),
      activity({ id: 'a2', application_id: 'app-1', title: 'Recruiter screen', occurred_at: '2026-08-10T00:00:00.000Z' }),
      activity({ id: 'a3', application_id: 'app-1', title: 'Rejected', occurred_at: '2026-08-05T00:00:00.000Z' }),
      // A different application's activity must never leak in.
      activity({ id: 'a4', application_id: 'app-2', title: 'Not mine' }),
    ]
    const response = await GET(get('?applicationId=app-1'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.activities.map((a: { id: string }) => a.id)).toEqual(['a2', 'a3', 'a1'])
  })

  it('caps at 50 activities', async () => {
    state.activities = Array.from({ length: 60 }, (_, i) =>
      activity({
        id: `a${i}`,
        application_id: 'app-1',
        occurred_at: new Date(2026, 0, 1 + i).toISOString(),
      })
    )
    const response = await GET(get('?applicationId=app-1'))
    const body = await response.json()
    expect(body.activities).toHaveLength(50)
  })
})
