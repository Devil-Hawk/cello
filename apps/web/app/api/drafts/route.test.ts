// What this tests: GET /api/drafts names a draft's company by the viewer's own row (person_jobs), else the
// employer in the directory. A shared role is stored under the company of whoever stored it first, so the
// service role must never embed companies(...) here: that company's name, logo and domain are another
// person's text. The fixture's role belongs to 'Theirs'; the viewer follows the same employer as 'Mine'.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface Fixture {
  draft: Record<string, unknown>
  personJobs: Record<string, unknown>[]
}

let state: Fixture
/** Every select string the route sent to the service-role client. */
let selects: { table: string; select: string }[]

const draft = (jobs: Record<string, unknown>) => ({
  id: 'd1',
  job_id: 'job-1',
  user_id: 'user-1',
  status: 'pending_review',
  created_at: '2026-10-01T00:00:00.000Z',
  jobs,
})

// What the old embed would have returned for this role: the first storer's company, with its logo and domain.
const SHARED_JOB = {
  id: 'job-1',
  title: 'Staff Engineer',
  url: 'https://boards.greenhouse.io/acme/jobs/1',
  location: 'Remote',
  company_id: 'co-theirs',
  companies: { name: 'Theirs', logo_url: 'https://theirs.example/logo.png', domain: 'theirs.example' },
  employer: { name: 'Directory Co', domain: 'directory.example', logo_url: 'https://directory.example/logo.png' },
}

function chain(table: string) {
  const filters: Record<string, unknown> = {}
  const self: Record<string, unknown> = {
    eq: (column: string, value: unknown) => ((filters[column] = value), self),
    in: (column: string, values: unknown[]) => ((filters[column] = values), self),
    order: () => self,
    limit: () => self,
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      const rows =
        table === 'application_drafts'
          ? [state.draft]
          : table === 'person_jobs'
            ? state.personJobs.filter((r) => r.viewer_id === filters.viewer_id && (filters.id as string[]).includes(r.id as string))
            : []
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    },
  }
  return self
}

const admin = {
  from(table: string) {
    return {
      select(select: string) {
        selects.push({ table, select })
        return chain(table)
      },
    }
  },
}
const supabase = { auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) } }

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/harness/supabase-admin', () => ({ createAdminClient: () => admin }))

import { GET } from './route'

const get = () => GET(new NextRequest('http://localhost/api/drafts'))

beforeEach(() => {
  selects = []
  state = {
    draft: draft(SHARED_JOB),
    personJobs: [{ id: 'job-1', viewer_id: 'user-1', viewer_company_name: 'Mine', viewer_company_domain: 'mine.example' }],
  }
})

describe('GET /api/drafts', () => {
  it('never asks the service role for companies(...)', async () => {
    await get()
    const sent = selects.find((s) => s.table === 'application_drafts')!.select
    expect(sent).not.toContain('companies(')
    expect(sent).not.toContain('company_id')
  })

  it("names the company by the viewer's own row, and carries nothing of the first storer's", async () => {
    const response = await get()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.drafts[0].jobs.companies).toMatchObject({ name: 'Mine', domain: 'mine.example' })
    const text = JSON.stringify(body)
    expect(text).toContain('Mine')
    // the route reads only what it selected, so the fixture's embed never reaches the response
    expect(text).not.toContain('Theirs')
    expect(text).not.toContain('theirs.example')
  })

  it('falls back to the directory employer when the viewer holds no company for the role', async () => {
    state.personJobs = []
    const body = await (await get()).json()
    expect(body.drafts[0].jobs.companies).toEqual({ name: 'Directory Co', domain: 'directory.example', logo_url: 'https://directory.example/logo.png' })
    expect(JSON.stringify(body)).not.toContain('Theirs')
  })

  it('reads the viewer\'s own row only, never another person\'s on the same role', async () => {
    state.personJobs = [
      { id: 'job-1', viewer_id: 'user-2', viewer_company_name: 'Someone Else', viewer_company_domain: 'else.example' },
      ...state.personJobs,
    ]
    const text = JSON.stringify(await (await get()).json())
    expect(text).toContain('Mine')
    expect(text).not.toContain('Someone Else')
  })
})
