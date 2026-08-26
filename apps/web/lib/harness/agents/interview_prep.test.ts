// Regression guard for the A2A-review IDOR: interview_prep's AgentFn wrapper
// fetches the target job by a caller-supplied jobId. Unlike its sibling
// agents (matcher.ts's fetchJobsByIds, company_researcher.ts's companyId
// fetch), it used to select('jobs')...eq('id', jobId).single() with NO
// ownership filter at all — any caller (including over A2A) could pull ANY
// user's job by jobId and generate an interview-prep kit from the victim's
// private job data. The fix reuses matcher.ts's ownedJobsQuery (the same
// companies!inner + .eq('companies.user_id', userId) guard already proven
// for matcher). ZERO network, ZERO real DB — admin is an in-memory fake.

import { describe, expect, it } from 'vitest'
import { interview_prep } from './interview_prep'
import type { AdminClient, StepContext } from '../types'

type Row = Record<string, unknown>

// Minimal fake of the PostgREST chain shapes interview_prep's wrapper uses:
// select().eq().eq().single() (jobs, via ownedJobsQuery) and
// select().eq().single() (profiles). Mirrors copilot-tools.test.ts's FakeQuery.
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  constructor(
    private rows: Row[],
    private allTables: Record<string, Row[]>
  ) {}
  select(_cols?: string) {
    return this
  }
  eq(col: string, val: unknown) {
    if (col.startsWith('companies.')) {
      const field = col.slice('companies.'.length)
      const byId = new Map((this.allTables.companies ?? []).map((c) => [c.id, c]))
      this.rows = this.rows.filter((r) => byId.get(r.company_id as string)?.[field] === val)
      return this
    }
    this.rows = this.rows.filter((r) => r[col] === val)
    return this
  }
  async single() {
    return { data: this.rows[0] ?? null, error: this.rows[0] ? null : { message: 'not found' } }
  }
  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled)
  }
}

function fakeAdmin(tables: Record<string, Row[]>): AdminClient {
  return {
    from(table: string) {
      return new FakeQuery([...(tables[table] ?? [])], tables)
    },
  } as unknown as AdminClient
}

const TABLES = {
  companies: [{ id: 'co-victim', user_id: 'victim' }],
  jobs: [{ id: 'job-1', title: 'Widget Engineer', description: null, location: null, company_id: 'co-victim' }],
  profiles: [{ id: 'attacker', resume_text: null }],
}

function baseCtx(overrides: Partial<StepContext>): StepContext {
  return {
    userId: 'attacker',
    runId: 'run-1',
    stepLabel: 'interview_prep',
    agentType: 'interview_prep',
    input: { jobId: 'job-1' },
    deps: {},
    admin: fakeAdmin(TABLES),
    apiKeys: { userId: 'attacker' },
    llm: async () => {
      throw new Error('llm should not be reached in this test')
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('interview_prep AgentFn — job ownership enforced transitively via companies.user_id', () => {
  it('refuses a jobId that belongs to another user (cross-tenant IDOR)', async () => {
    await expect(interview_prep(baseCtx({}))).rejects.toThrow(/job job-1 not found/)
  })

  it('proceeds (past the ownership check) for a job the caller actually owns', async () => {
    const admin = fakeAdmin({
      companies: [{ id: 'co-mine', user_id: 'owner' }],
      jobs: [{ id: 'job-1', title: 'Widget Engineer', description: null, location: null, company_id: 'co-mine' }],
      profiles: [{ id: 'owner', resume_text: null }],
    })
    const result = await interview_prep(baseCtx({ userId: 'owner', admin }))
    // No resume on file and no LLM key -> degrades cleanly BEFORE ever
    // touching the LLM, but only after the ownership-scoped fetch succeeded.
    expect(result.output).toMatchObject({ jobId: 'job-1', needsResume: true })
  })
})
