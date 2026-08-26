// What this tests: the route reports the TRUE total (`count`) even when
// `limit` caps what's rendered, scopes strictly to this user's pending_review
// rows, and never 500s just because a job's company join came back empty.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface DraftFixture {
  id: string
  user_id: string
  status: string
  job_id: string
  resume_summary: string | null
  answers: unknown
  created_at: string
  jobs: {
    title: string
    url: string | null
    description: string | null
    location: string | null
    companies: { name: string; metadata: unknown } | null
  } | null
}

interface VerdictFixture {
  subject_id: string
  user_id: string
  subject_kind: string
  verdict: string
  created_at: string
}

let state: {
  user: { id: string } | null
  profile: Record<string, unknown> | null
  drafts: DraftFixture[]
  evalVerdicts: VerdictFixture[]
}

const GREENHOUSE_URL = 'https://boards.greenhouse.io/acme/jobs/4001'

function draft(over: Partial<DraftFixture> & { id: string }): DraftFixture {
  return {
    user_id: 'user-1',
    status: 'pending_review',
    job_id: `job-${over.id}`,
    resume_summary: 'Backend engineer, five years of Go.',
    answers: {},
    created_at: '2026-08-03T06:00:00.000Z',
    jobs: {
      title: 'Senior Backend Engineer',
      url: GREENHOUSE_URL,
      description: 'Build services. Ship them.',
      location: 'Remote',
      companies: { name: 'Acme', metadata: {} },
    },
    ...over,
  }
}

/** Chainable query stub. `.eq()` accumulates filters; the row-shape and the
 *  {count, head} option on `.select()` decide what the terminal read resolves
 *  to — a single profile row, a filtered drafts array, or just a count. */
function chain(table: string, opts?: { count?: string; head?: boolean }) {
  const filters: Record<string, unknown> = {}
  const inFilters: Record<string, unknown[]> = {}
  let orderBy: { column: string; ascending: boolean } | null = null
  let limitTo: number | null = null
  const self: Record<string, unknown> = {
    eq(column: string, value: unknown) {
      filters[column] = value
      return self
    },
    in(column: string, values: unknown[]) {
      inFilters[column] = values
      return self
    },
    order(column: string, orderOpts?: { ascending?: boolean }) {
      orderBy = { column, ascending: orderOpts?.ascending !== false }
      return self
    },
    limit(n: number) {
      limitTo = n
      return self
    },
    single: async () => {
      if (table === 'profiles') return { data: state.profile, error: null }
      return { data: null, error: null }
    },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      const matchesEq = (row: Record<string, unknown>) =>
        Object.entries(filters).every(([col, val]) => row[col] === val)
      const matchesIn = (row: Record<string, unknown>) =>
        Object.entries(inFilters).every(([col, vals]) => vals.includes(row[col]))
      let rows: Record<string, unknown>[] =
        table === 'application_drafts'
          ? (state.drafts as unknown as Record<string, unknown>[]).filter(matchesEq)
          : table === 'eval_verdicts'
            ? (state.evalVerdicts as unknown as Record<string, unknown>[]).filter((v) => matchesEq(v) && matchesIn(v))
            : []
      if (orderBy) {
        const { column, ascending } = orderBy
        rows = [...rows].sort((a, b) => {
          const av = a[column] as string
          const bv = b[column] as string
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      // The count query passes `limit` = false through .limit() too, since the
      // route always calls it — but `head:true` must keep counting the WHOLE
      // filtered set, exactly like Postgres does: a head request never trims.
      const result = opts?.head
        ? { data: null, error: null, count: rows.length }
        : { data: limitTo !== null ? rows.slice(0, limitTo) : rows, error: null }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return self
}

const admin = {
  from(table: string) {
    return {
      select(_selectArg: string, opts?: { count?: string; head?: boolean }) {
        return chain(table, opts)
      },
    }
  },
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))

import { GET } from './route'

function get(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/notifications/queue${query}`)
}

beforeEach(() => {
  state = {
    user: { id: 'user-1' },
    profile: {
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
      resume_text: 'Ada Lovelace — engineer.',
      preferences: {},
    },
    drafts: [],
    evalVerdicts: [],
  }
})

describe('GET /api/notifications/queue', () => {
  it('refuses a signed-out request', async () => {
    state.user = null
    const response = await GET(get())
    expect(response.status).toBe(401)
  })

  it('returns an empty queue honestly rather than an error when there is nothing pending', async () => {
    const response = await GET(get())
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({ items: [], count: 0 })
  })

  it('reports each pending item with a WHY sentence, not just a status', async () => {
    state.drafts = [draft({ id: 'd1' })]
    const response = await GET(get())
    const body = await response.json()
    expect(body.count).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ draftId: 'd1', companyName: 'Acme', title: 'Senior Backend Engineer' })
    expect(typeof body.items[0].reason).toBe('string')
    expect(body.items[0].reason.length).toBeGreaterThan(0)
  })

  it('never returns another user\'s drafts', async () => {
    state.drafts = [draft({ id: 'mine' }), draft({ id: 'theirs', user_id: 'user-2' })]
    const response = await GET(get())
    const body = await response.json()
    expect(body.items.map((i: { draftId: string }) => i.draftId)).toEqual(['mine'])
  })

  it('excludes drafts that already left pending_review (approved, submitted, rejected)', async () => {
    state.drafts = [
      draft({ id: 'pending' }),
      draft({ id: 'approved', status: 'approved' }),
      draft({ id: 'submitted', status: 'submitted' }),
    ]
    const response = await GET(get())
    const body = await response.json()
    expect(body.items.map((i: { draftId: string }) => i.draftId)).toEqual(['pending'])
    expect(body.count).toBe(1)
  })

  it('reports the TRUE total even when limit caps the rendered list', async () => {
    state.drafts = [draft({ id: 'a' }), draft({ id: 'b' }), draft({ id: 'c' })]
    const response = await GET(get('?limit=1'))
    const body = await response.json()
    expect(body.items).toHaveLength(1)
    expect(body.count).toBe(3)
  })

  it('does not 500 when a draft\'s job join is missing', async () => {
    state.drafts = [draft({ id: 'orphan', jobs: null })]
    const response = await GET(get())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.items[0].title).toBe('Untitled role')
    expect(body.items[0].companyName).toBe('Unknown company')
  })

  it('attaches the latest verdict as a pass/fail/unjudged chip, and omits it entirely when never judged', async () => {
    state.drafts = [draft({ id: 'judged-pass' }), draft({ id: 'judged-refused' }), draft({ id: 'never-judged' })]
    state.evalVerdicts = [
      { subject_id: 'judged-pass', user_id: 'user-1', subject_kind: 'cv_tailor_draft', verdict: 'fail', created_at: '2026-08-01T00:00:00.000Z' },
      // A regen re-judged this draft — the LATER row (by created_at) wins.
      { subject_id: 'judged-pass', user_id: 'user-1', subject_kind: 'cv_tailor_draft', verdict: 'pass', created_at: '2026-08-02T00:00:00.000Z' },
      { subject_id: 'judged-refused', user_id: 'user-1', subject_kind: 'cv_tailor_draft', verdict: 'insufficient-budget', created_at: '2026-08-01T00:00:00.000Z' },
      // A different subject_kind for the same id must never leak in.
      { subject_id: 'never-judged', user_id: 'user-1', subject_kind: 'match_score', verdict: 'pass', created_at: '2026-08-01T00:00:00.000Z' },
    ]

    const response = await GET(get())
    const body = await response.json()
    const byId = Object.fromEntries(body.items.map((i: { draftId: string; verdict?: string }) => [i.draftId, i.verdict]))

    expect(byId['judged-pass']).toBe('pass')
    expect(byId['judged-refused']).toBe('unjudged')
    expect(byId['never-judged']).toBeUndefined()
  })
})
