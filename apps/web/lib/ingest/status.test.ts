import { describe, expect, it } from 'vitest'
import { FAILURE_TEXT, nextCheckAfter, readFindNewRoles } from './status'

const NOW = new Date('2026-10-06T17:00:00Z')

function fakeClient(opts: { run?: Record<string, unknown> | null; companies?: { id: string; name: string }[]; count?: number }) {
  const companies = opts.companies ?? []
  const client = {
    from(table: string) {
      if (table === 'ingestion_runs') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => b,
          limit: () => b,
          maybeSingle: async () => ({ data: opts.run ?? null, error: null }),
        }
        return b
      }
      if (table === 'companies') {
        const b: Record<string, unknown> = {
          select: (_cols: string, o?: { head?: boolean }) => (o?.head ? Promise.resolve({ count: opts.count ?? companies.length, error: null }) : b),
          in: (_col: string, ids: string[]) => Promise.resolve({ data: companies.filter((c) => ids.includes(c.id)), error: null }),
        }
        return b
      }
      throw new Error(table)
    },
  }
  return client as never
}

const run = (over: Record<string, unknown> = {}) => ({
  status: 'succeeded',
  started_at: '2026-10-06T12:41:00Z',
  finished_at: '2026-10-06T12:58:00Z',
  companies_checked: 42,
  companies_total: 42,
  jobs_new: 7,
  jobs_updated: 2,
  jobs_closed: 3,
  failed_companies: [],
  ...over,
})

describe('nextCheckAfter', () => {
  it('is 18:41 UTC from 17:00 UTC, the same cron as the scheduled workflow', () => {
    expect(nextCheckAfter(NOW).toISOString()).toBe('2026-10-06T18:41:00.000Z')
  })
  it('rolls to the next day after the last check of the day, and past an exact check time', () => {
    expect(nextCheckAfter(new Date('2026-10-06T19:00:00Z')).toISOString()).toBe('2026-10-07T00:41:00.000Z')
    expect(nextCheckAfter(new Date('2026-10-06T18:41:00Z')).toISOString()).toBe('2026-10-07T00:41:00.000Z')
  })
})

describe('readFindNewRoles', () => {
  it('is never, and says whether there are companies to check', async () => {
    expect(await readFindNewRoles(fakeClient({ run: null, count: 0 }), NOW)).toMatchObject({ state: 'never', hasCompanies: false })
    expect(await readFindNewRoles(fakeClient({ run: null, count: 3 }), NOW)).toMatchObject({ state: 'never', hasCompanies: true })
  })

  it('reads a finished check', async () => {
    expect(await readFindNewRoles(fakeClient({ run: run() }), NOW)).toMatchObject({
      state: 'done',
      companiesChecked: 42,
      companiesTotal: 42,
      jobsNew: 7,
      jobsUpdated: 2,
      jobsClosed: 3,
      nextCheckAt: '2026-10-06T18:41:00.000Z',
    })
  })

  it('reads a check in progress as checking, and one that has been running over two hours as failed', async () => {
    const fresh = run({ status: 'running', finished_at: null, started_at: '2026-10-06T16:30:00Z' })
    expect((await readFindNewRoles(fakeClient({ run: fresh }), NOW)).state).toBe('checking')
    const stale = run({ status: 'running', finished_at: null, started_at: '2026-10-06T14:30:00Z' })
    expect((await readFindNewRoles(fakeClient({ run: stale }), NOW)).state).toBe('failed')
  })

  it('maps companies that were not checked to their names and the copy for the reason', async () => {
    const res = await readFindNewRoles(
      fakeClient({
        run: run({
          status: 'partial',
          companies_checked: 40,
          failed_companies: [
            { company_id: 'c1', provider: 'greenhouse', reason: 'board_error' },
            { company_id: 'c2', provider: 'page_reader', reason: 'model_unavailable' },
            { company_id: 'gone', provider: 'page_reader', reason: 'fetch_failed' },
            { company_id: 'c1', provider: 'x', reason: 'not-a-reason' },
          ],
        }),
        companies: [
          { id: 'c1', name: 'Acme' },
          { id: 'c2', name: 'Globex' },
        ],
      }),
      NOW
    )
    expect(res.state).toBe('partial')
    expect(res.failed).toEqual([
      { companyId: 'c1', companyName: 'Acme', reason: 'board_error', text: 'Its job board did not respond' },
      { companyId: 'c2', companyName: 'Globex', reason: 'model_unavailable', text: 'Its careers page needs reading and no model was free' },
    ])
  })

  it('has copy for every reason the check can record, with no engineering words and no em dash', () => {
    for (const text of Object.values(FAILURE_TEXT)) {
      expect(text).not.toMatch(/\b(run|thread|tick|step|graph|agent|scrape|ingest)\b/i)
      expect(text).not.toContain('—')
    }
    expect(Object.keys(FAILURE_TEXT).sort()).toEqual(
      ['board_error', 'fetch_failed', 'model_limit', 'model_unavailable', 'page_unconfirmed', 'time'].sort()
    )
  })
})
