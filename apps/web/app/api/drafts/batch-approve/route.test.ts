// What this file is really testing: that the CLIENT'S OPINION IS NEVER AN INPUT
// to whether an application leaves the user's name.
//
// The batch review necessarily hands the browser a list of ids and lets it send
// back a subset. If the route trusted that subset, then unchecking a knock-out
// item would be the only thing standing between a visa-sponsorship question and
// an application that answers it wrong — and "the checkbox was unticked" is not
// a safety property, it is a hope. So most of the assertions below are about
// what did NOT happen: submitApplication not called, no row written, zero
// applications created.
//
// The other half is idempotence. A batch is fifty irreversible outward-facing
// actions driven over several HTTP rounds, which is exactly the shape that
// double-fires on a retry, a double-click or a second tab. Two tests replay the
// same request and assert the second one submits nothing.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const submitApplication = vi.fn()

/** Every write the route attempted, in order, so a test can assert what reached
 *  the database — and, for the refused cases, what never did. */
let writes: Array<{ table: string; op: 'update' | 'insert'; payload: Record<string, unknown> }> = []

interface DraftFixture {
  id: string
  job_id: string
  status: string
  resume_summary: string | null
  cover_letter: string | null
  answers: unknown
  created_at: string
  jobs: {
    id: string
    title: string
    url: string | null
    description: string | null
    location: string | null
    match_score: number | null
    match_details: unknown
    companies: { name: string; metadata: unknown }
  }
}

let state: {
  user: { id: string; email: string } | null
  profile: Record<string, unknown> | null
  drafts: DraftFixture[]
  /** applications rows keyed by job_id. */
  applications: Record<string, { id: string; applied_at: string | null }>
}

const GREENHOUSE_URL = 'https://boards.greenhouse.io/acme/jobs/4001'

function draft(over: Partial<DraftFixture> & { id: string; job_id: string }): DraftFixture {
  return {
    status: 'pending_review',
    resume_summary: 'Backend engineer, five years of Go and Postgres.',
    cover_letter: 'Dear team,',
    answers: {},
    created_at: '2026-08-03T06:00:00.000Z',
    ...over,
    jobs: {
      id: over.job_id,
      title: 'Senior Backend Engineer',
      url: GREENHOUSE_URL,
      description: 'Build services. Ship them.',
      location: 'Remote',
      match_score: 88,
      match_details: { summary: 'Strong Go overlap.' },
      companies: { name: 'Acme', metadata: {} },
      ...(over.jobs ?? {}),
    },
  }
}

/** A supabase-js query builder that records what it was asked to do and
 *  resolves with whatever the fixture says. */
function builder(resolve: () => { data: unknown; error: unknown }) {
  const self: Record<string, unknown> = {}
  const filters: Array<[string, unknown]> = []
  const passthrough = (column?: string, value?: unknown) => {
    if (typeof column === 'string') filters.push([column, value])
    return self
  }
  Object.assign(self, {
    _filters: filters,
    select: () => self,
    eq: passthrough,
    in: passthrough,
    order: () => self,
    limit: () => self,
    maybeSingle: async () => {
      const { data, error } = resolve()
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
    },
    single: async () => {
      const { data, error } = resolve()
      return { data: Array.isArray(data) ? (data[0] ?? null) : data, error }
    },
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(res, rej),
  })
  return self
}

function filterValue(chain: Record<string, unknown>, column: string): unknown {
  const filters = chain._filters as Array<[string, unknown]>
  const hit = filters.find(([c]) => c === column)
  return hit?.[1]
}

const admin = {
  from(table: string) {
    return {
      select() {
        const chain = builder(() => {
          if (table === 'profiles') return { data: state.profile, error: null }
          if (table === 'applications') {
            const jobId = filterValue(chain, 'job_id') as string | undefined
            return { data: jobId ? (state.applications[jobId] ?? null) : null, error: null }
          }
          // eval_verdicts: unjudgedCvTailorDraftIds — no fixture in this file
          // ever writes one, so every draft is judged (empty set) by default.
          if (table === 'eval_verdicts') return { data: [], error: null }
          // application_drafts: by id, or the whole pending list.
          const id = filterValue(chain, 'id') as string | undefined
          const status = filterValue(chain, 'status') as string | undefined
          if (id) return { data: state.drafts.find((d) => d.id === id) ?? null, error: null }
          const rows = status ? state.drafts.filter((d) => d.status === status) : state.drafts
          return { data: rows, error: null }
        })
        return chain
      },
      update(payload: Record<string, unknown>) {
        const chain = builder(() => {
          writes.push({ table, op: 'update', payload })
          if (table !== 'application_drafts') return { data: [], error: null }
          const id = filterValue(chain, 'id') as string
          const requiredStatus = filterValue(chain, 'status') as string | undefined
          const row = state.drafts.find((d) => d.id === id)
          // THE CLAIM. Postgres re-evaluates the WHERE under the row lock, so a
          // second racing update matches nothing once the first has landed —
          // reproduced here by checking the CURRENT status before mutating.
          if (!row || (requiredStatus !== undefined && row.status !== requiredStatus)) {
            return { data: [], error: null }
          }
          if (typeof payload.status === 'string') row.status = payload.status
          if (payload.answers !== undefined) row.answers = payload.answers
          return { data: [{ id }], error: null }
        })
        return chain
      },
      insert(payload: Record<string, unknown>) {
        writes.push({ table, op: 'insert', payload })
        if (table === 'applications') {
          state.applications[payload.job_id as string] = {
            id: `app-${payload.job_id}`,
            applied_at: (payload.applied_at as string) ?? null,
          }
        }
        return builder(() => ({ data: null, error: null }))
      },
    }
  },
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))
vi.mock('@/lib/ats-apply', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, submitApplication: (...args: unknown[]) => submitApplication(...args) }
})

import { GET, POST } from './route'
import { BATCH_APPROVE_CAP } from './eligibility'

function post(body: unknown) {
  return new NextRequest('http://localhost/api/drafts/batch-approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A well-formed confirmed batch. Tests override one field at a time. */
function batch(over: Record<string, unknown> = {}) {
  return {
    draftIds: ['d1'],
    batchId: 'batch-0001-aaaa',
    confirmed: true,
    confirmedAt: new Date().toISOString(),
    cursor: 0,
    ...over,
  }
}

beforeEach(() => {
  writes = []
  submitApplication.mockReset()
  submitApplication.mockResolvedValue({
    outcome: 'submitted',
    submissionRef: 'gh-777',
    provider: 'greenhouse',
  })
  state = {
    user: { id: 'user-1', email: 'login@university.edu' },
    profile: {
      full_name: 'Ada Lovelace',
      email: 'login@university.edu',
      resume_text: 'Ada Lovelace — engineer.',
      preferences: { autopilot: { atsKeys: { greenhouse: 'employer-key' } } },
    },
    drafts: [draft({ id: 'd1', job_id: 'job-1' })],
    applications: {},
  }
})

// --- The human gate ---------------------------------------------------------

describe('POST — a batch nobody confirmed does nothing', () => {
  it('refuses a payload without confirmed:true, and writes nothing', async () => {
    const response = await POST(post({ ...batch(), confirmed: undefined }))
    expect(response.status).toBe(400)
    expect(submitApplication).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses a truthy-but-not-true confirmation', async () => {
    const response = await POST(post({ ...batch(), confirmed: 'yes' }))
    expect(response.status).toBe(400)
    expect(submitApplication).not.toHaveBeenCalled()
  })

  it('refuses a confirmation older than the engine will honour', async () => {
    const stale = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    const response = await POST(post(batch({ confirmedAt: stale })))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('24 hours') })
    expect(submitApplication).not.toHaveBeenCalled()
  })

  it('passes the confirmation through to the submission engine, scoped to one job', async () => {
    const confirmedAt = new Date().toISOString()
    await POST(post(batch({ confirmedAt })))
    expect(submitApplication).toHaveBeenCalledTimes(1)
    expect(submitApplication.mock.calls[0][0]).toMatchObject({
      authorization: {
        confirmed: true,
        source: 'human-approval-route',
        at: confirmedAt,
        // Not the whole batch: an approval that named every job would authorize
        // every job for every item.
        jobIds: ['job-1'],
        batchId: 'batch-0001-aaaa',
      },
    })
  })
})

// --- The cap ----------------------------------------------------------------

describe('POST — the cap holds before anything is sent', () => {
  it('refuses an over-cap batch outright rather than applying to the first N', async () => {
    const draftIds = Array.from({ length: BATCH_APPROVE_CAP + 1 }, (_, i) => `d${i}`)
    const response = await POST(post(batch({ draftIds })))
    expect(response.status).toBe(400)
    expect(submitApplication).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('counts DEDUPED ids against the cap, so repeats cannot pad a payload past it', async () => {
    // Well over the cap in length, but only two distinct applications.
    const draftIds = Array.from({ length: BATCH_APPROVE_CAP + 20 }, (_, i) => (i % 2 ? 'd1' : 'd2'))
    state.drafts = [draft({ id: 'd1', job_id: 'job-1' }), draft({ id: 'd2', job_id: 'job-2' })]
    const response = await POST(post(batch({ draftIds })))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.total).toBe(2)
    expect(submitApplication).toHaveBeenCalledTimes(2)
  })
})

// --- Server-side re-validation ----------------------------------------------

describe('POST — every item is re-validated from the database, not from the payload', () => {
  it('refuses a knock-out posting the client offered anyway, and leaves the draft alone', async () => {
    state.drafts = [
      draft({
        id: 'd1',
        job_id: 'job-1',
        jobs: {
          id: 'job-1',
          title: 'Senior Backend Engineer',
          url: GREENHOUSE_URL,
          description: 'Will you now or in the future require visa sponsorship?',
          location: 'Remote',
          match_score: 88,
          match_details: null,
          companies: { name: 'Acme', metadata: {} },
        },
      }),
    ]

    const response = await POST(post(batch()))
    const body = await response.json()

    expect(submitApplication).not.toHaveBeenCalled()
    expect(body.results[0]).toMatchObject({ outcome: 'blocked' })
    expect(body.results[0].blockers.join(' ')).toContain('visa/sponsorship')
    // Untouched: it has to stay in the queue for the individual attention it needs.
    expect(writes).toEqual([])
    expect(state.drafts[0].status).toBe('pending_review')
  })

  it('refuses a draft whose stored answers already deferred a legal question, even when the live description is clean', async () => {
    state.drafts = [
      draft({ id: 'd1', job_id: 'job-1', answers: { deferredToHuman: ['salary expectation'] } }),
    ]
    const body = await (await POST(post(batch()))).json()
    expect(submitApplication).not.toHaveBeenCalled()
    expect(body.results[0].outcome).toBe('blocked')
    expect(body.results[0].blockers.join(' ')).toContain('salary expectation')
  })

  it('refuses an application whose identity is incomplete rather than sending a half-empty one', async () => {
    state.profile = { full_name: '', email: '', resume_text: null, preferences: {} }
    const body = await (await POST(post(batch()))).json()
    expect(submitApplication).not.toHaveBeenCalled()
    expect(body.results[0].outcome).toBe('blocked')
  })

  it('refuses a draft id belonging to somebody else as simply not found', async () => {
    const body = await (await POST(post(batch({ draftIds: ['not-mine'] })))).json()
    expect(submitApplication).not.toHaveBeenCalled()
    expect(body.results[0]).toMatchObject({ outcome: 'skipped' })
    expect(writes).toEqual([])
  })

  it('refuses the whole batch when the configured apply address is malformed', async () => {
    state.profile = {
      ...(state.profile as Record<string, unknown>),
      preferences: { contact: { applyEmail: 'not-an-address' } },
    }
    const response = await POST(post(batch()))
    expect(response.status).toBe(400)
    expect(submitApplication).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})

// --- Idempotence ------------------------------------------------------------

describe('POST — a repeated request does not apply twice', () => {
  it('submits once across two identical calls', async () => {
    const body = batch()
    const first = await (await POST(post(body))).json()
    expect(first.results[0].outcome).toBe('submitted')

    const second = await (await POST(post(body))).json()
    expect(submitApplication).toHaveBeenCalledTimes(1)
    expect(second.results[0]).toMatchObject({ outcome: 'skipped' })
    expect(second.results[0].reason).toContain('Already submitted')
  })

  it('skips a role the user has already applied to, however the draft got left behind', async () => {
    state.applications['job-1'] = { id: 'app-1', applied_at: '2026-08-01T10:00:00.000Z' }
    const body = await (await POST(post(batch()))).json()
    expect(submitApplication).not.toHaveBeenCalled()
    expect(body.results[0]).toMatchObject({ outcome: 'skipped' })
    expect(body.results[0].reason).toContain('already applied')
  })

  it('lets only one of two concurrent runs claim the same draft', async () => {
    const [a, b] = await Promise.all([POST(post(batch())), POST(post(batch({ batchId: 'batch-0002-bbbb' })))])
    const outcomes = [(await a.json()).results[0].outcome, (await b.json()).results[0].outcome].sort()
    expect(submitApplication).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual(['skipped', 'submitted'])
  })
})

// --- The resumable run ------------------------------------------------------

describe('POST — the run is bounded and resumable', () => {
  it('reports a cursor that advances and a done flag that ends the loop', async () => {
    state.drafts = Array.from({ length: 3 }, (_, i) =>
      draft({ id: `d${i + 1}`, job_id: `job-${i + 1}` })
    )
    const draftIds = ['d1', 'd2', 'd3']

    const round = await (await POST(post(batch({ draftIds, cursor: 2 })))).json()
    expect(round.processed).toBe(1)
    expect(round.cursor).toBeNull()
    expect(round.done).toBe(true)
    expect(round.total).toBe(3)
  })

  it('records a per-item result for every item so a partial failure is legible', async () => {
    state.drafts = [draft({ id: 'd1', job_id: 'job-1' }), draft({ id: 'd2', job_id: 'job-2' })]
    submitApplication
      .mockResolvedValueOnce({ outcome: 'submitted', submissionRef: 'gh-1', provider: 'greenhouse' })
      .mockResolvedValueOnce({ outcome: 'failed', provider: 'greenhouse', error: 'boom' })

    const body = await (await POST(post(batch({ draftIds: ['d1', 'd2'] })))).json()
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['submitted', 'failed'])
    expect(body.totals).toMatchObject({ submitted: 1, failed: 1 })
  })
})

// --- The manifest -----------------------------------------------------------

describe('GET — the manifest splits what may be batched from what may not', () => {
  it('puts a knock-out posting in needsAttention and never in the approvable list', async () => {
    state.drafts = [
      draft({ id: 'd1', job_id: 'job-1' }),
      draft({
        id: 'd2',
        job_id: 'job-2',
        jobs: {
          id: 'job-2',
          title: 'Cleared Systems Engineer',
          url: 'https://jobs.lever.co/acme/2222-3333-4444',
          description: 'Requires an active security clearance.',
          location: 'DC',
          match_score: 70,
          match_details: null,
          companies: { name: 'Beta', metadata: {} },
        },
      }),
    ]

    const body = await (await GET()).json()
    expect(body.items.map((i: { draftId: string }) => i.draftId)).toEqual(['d1'])
    expect(body.needsAttention.map((i: { draftId: string }) => i.draftId)).toEqual(['d2'])
    expect(body.counts).toMatchObject({ batchable: 1, needsAttention: 1 })
  })

  it('names the address applications will carry, preferring the apply address over the login', async () => {
    state.profile = {
      ...(state.profile as Record<string, unknown>),
      preferences: { contact: { applyEmail: 'ada@personal.dev' } },
    }
    const body = await (await GET()).json()
    expect(body.applyEmail).toBe('ada@personal.dev')
    expect(body.applyEmailSource).toBe('settings')
    expect(body.accountEmail).toBe('login@university.edu')
  })

  it('never ships the job description to the client — only the verdict drawn from it', async () => {
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toContain('Build services. Ship them.')
  })
})
