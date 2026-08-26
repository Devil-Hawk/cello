// Tests for lib/graph/refresh.ts's refreshJobsGraph. Same testing philosophy
// as runs.test.ts: real @langchain/langgraph MemorySaver (real Functional
// API memoization/interrupt/resume machinery), refreshCompany itself mocked
// (this file tests orchestration — dispatch, deadline, resume, per-company
// isolation — not lib/ats's own provider-detection logic, which has its own
// tests). ZERO network, ZERO real Postgres.
//
// These tests also carry the guarantees the deleted app/api/jobs/refresh/
// bounded-run.test.ts used to pin (contiguous-prefix processing, forward
// progress under a deadline, bounded concurrency) — see this file's header
// on why they now live here instead of a standalone bounded-run.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CompanyInput, CompanyRefreshResult } from '../ats'

const refreshCompanyMock = vi.fn(async (_store: unknown, _company: CompanyInput): Promise<CompanyRefreshResult> => {
  throw new Error('refresh.test.ts: refreshCompanyMock has no implementation for this call')
})
vi.mock('../ats', () => ({
  refreshCompany: (store: unknown, company: CompanyInput) => refreshCompanyMock(store, company),
}))

// Same literal @langchain/langgraph's Pregel runtime reads a per-call
// checkpointer override off — see lib/graph/invoke.ts's PREGEL_CHECKPOINTER_KEY
// comment for how this was verified. This file bypasses invoke.ts entirely
// (it tests the raw compiled graph), so it needs the same literal.
const PREGEL_CHECKPOINTER_KEY = '__pregel_checkpointer'

function makeConfig(threadId: string, saver: MemorySaver, dbClient: unknown = { fake: 'client' }) {
  return {
    configurable: {
      thread_id: threadId,
      threadId,
      dbClient,
      [PREGEL_CHECKPOINTER_KEY]: saver,
    },
  }
}

function fakeResult(companyId: string, overrides: Partial<CompanyRefreshResult> = {}): CompanyRefreshResult {
  return {
    companyId,
    companyName: `Company ${companyId}`,
    provider: 'greenhouse',
    found: 1,
    inserted: 1,
    errors: [],
    ...overrides,
  }
}

function inputFor(companyIds: string[]) {
  return {
    companyIds,
    perCompanyOptions: Object.fromEntries(
      companyIds.map((id) => [id, { name: `Company ${id}`, domain: null, career_url: null }])
    ),
  }
}

let refreshJobsGraph: typeof import('./refresh').refreshJobsGraph
let getRefreshDeadlineInterrupt: typeof import('./refresh').getRefreshDeadlineInterrupt
let MissingDbClientError: typeof import('./refresh').MissingDbClientError

beforeEach(async () => {
  vi.resetModules()
  refreshCompanyMock.mockReset()
  ;({ refreshJobsGraph, getRefreshDeadlineInterrupt, MissingDbClientError } = await import('./refresh'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshJobsGraph — happy path', () => {
  it('processes every company, in order, and returns totals + a real store built from config.configurable.dbClient', async () => {
    const seenStores: unknown[] = []
    refreshCompanyMock.mockImplementation(async (store, company) => {
      seenStores.push(store)
      return fakeResult(company.id, { found: 2, inserted: 1 })
    })

    const saver = new MemorySaver()
    const dbClient = { marker: 'the-rls-scoped-client' }
    const config = makeConfig('t-happy', saver, dbClient)

    const outcome = await refreshJobsGraph.invoke(inputFor(['c1', 'c2', 'c3']), config)

    expect((outcome as { processed: number }).processed).toBe(3)
    expect((outcome as { total: number }).total).toBe(3)
    const o = outcome as {
      results: CompanyRefreshResult[]
      totals: { found: number; inserted: number; companiesWithAts: number }
    }
    expect(o.results.map((r) => r.companyId)).toEqual(['c1', 'c2', 'c3'])
    expect(o.totals).toEqual({ found: 6, inserted: 3, companiesWithAts: 3 })

    // RULING 9: every per-company task built its store from
    // config.configurable.dbClient, not from anywhere else — proves getConfig()
    // inside a task() call actually sees a custom key threaded onto the
    // invoking config, not just the {thread_id, threadId} LangGraph itself needs.
    expect(seenStores).toHaveLength(3)
    for (const store of seenStores) {
      expect(store).not.toBe(dbClient) // makeStore() wraps it into an AtsStore
      expect(store).toHaveProperty('listJobExternalIds')
    }
  })

  it('refuses up front when config.configurable.dbClient is absent', async () => {
    const saver = new MemorySaver()
    const config = {
      configurable: { thread_id: 't-no-client', threadId: 't-no-client', [PREGEL_CHECKPOINTER_KEY]: saver },
    }
    await expect(refreshJobsGraph.invoke(inputFor(['c1']), config)).rejects.toBeInstanceOf(MissingDbClientError)
    expect(refreshCompanyMock).not.toHaveBeenCalled()
  })
})

describe('refreshJobsGraph — per-company failure isolation', () => {
  it('one company reporting errors (refreshCompany never throws by its own contract) never stops the others', async () => {
    refreshCompanyMock.mockImplementation(async (_store, company) => {
      if (company.id === 'bad') {
        return fakeResult('bad', { provider: null, found: 0, inserted: 0, errors: ['detection failed: boom'] })
      }
      return fakeResult(company.id)
    })

    const saver = new MemorySaver()
    const outcome = (await refreshJobsGraph.invoke(inputFor(['ok1', 'bad', 'ok2']), makeConfig('t-isolate', saver))) as {
      results: CompanyRefreshResult[]
      processed: number
      totals: { companiesWithAts: number }
    }

    expect(outcome.processed).toBe(3)
    const bad = outcome.results.find((r) => r.companyId === 'bad')!
    expect(bad.errors).toEqual(['detection failed: boom'])
    expect(outcome.results.map((r) => r.companyId)).toEqual(['ok1', 'bad', 'ok2'])
    // companiesWithAts excludes the failed one (provider: null), same as the
    // pre-port route's own totals computation.
    expect(outcome.totals.companiesWithAts).toBe(2)
  })
})

// More companies than COMPANY_CONCURRENCY (5), so the first wave of claims
// cannot alone exhaust the list — the deadline check between waves is what
// these tests actually exercise. (With companyIds.length <= concurrency,
// every index is claimed synchronously in one JS turn, before any mocked
// company call has run long enough to move a fake clock — a real interleaving
// hazard this file's first draft hit and this comment now documents.)
const EIGHT = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']

describe('refreshJobsGraph — deadline interrupt + resume', () => {
  it('interrupts with {kind, processed, total} once the deadline passes, and resuming completes the remainder without re-running finished companies', async () => {
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let jumped = false

    refreshCompanyMock.mockImplementation(async (_store, company) => {
      if (!jumped) {
        jumped = true
        now += 10_000_000 // jump far past TIME_BUDGET_MS once the first wave is in flight
      }
      return fakeResult(company.id)
    })

    const saver = new MemorySaver()
    const config = makeConfig('t-deadline', saver)

    const first = await refreshJobsGraph.invoke(inputFor(EIGHT), config)
    expect(first).toEqual(expect.objectContaining({ __interrupt__: expect.any(Array) }))
    const payload = getRefreshDeadlineInterrupt(first)
    expect(payload).not.toBeNull()
    expect(payload!.total).toBe(8)
    // PORTED GUARANTEE (from the deleted bounded-run.test.ts's "always runs
    // at least one item, even if the deadline has already passed"): a run
    // that hits its deadline still makes real forward progress rather than
    // reporting processed:0 forever. The first wave (width 5) claims before
    // the clock jump can be observed; the deadline check only blocks the
    // NEXT wave's claims — so progress here is "one full wave", the
    // smallest unit this concurrency-bounded scheduler can make atomically.
    expect(payload!.processed).toBeGreaterThan(0)
    expect(payload!.processed).toBe(5)
    const firstRoundIds = refreshCompanyMock.mock.calls.map((c) => c[1].id).sort()
    expect(firstRoundIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])

    nowSpy.mockRestore() // give the resumed attempt a full, real deadline window
    refreshCompanyMock.mockClear()

    const second = await refreshJobsGraph.invoke(null, config)
    expect(getRefreshDeadlineInterrupt(second)).toBeNull()
    const outcome = second as { processed: number; total: number; results: CompanyRefreshResult[] }
    expect(outcome.processed).toBe(8)
    expect(outcome.total).toBe(8)
    expect(outcome.results.map((r) => r.companyId)).toEqual(EIGHT)

    // The first 5 were ADOPTED — memoized, never re-invoked. Only c6-c8 ran
    // for real on the resumed attempt.
    expect(refreshCompanyMock).toHaveBeenCalledTimes(3)
    expect(refreshCompanyMock.mock.calls.map((c) => c[1].id).sort()).toEqual(['c6', 'c7', 'c8'])
  })

})

// PORTED GUARANTEE, continued: "at least one item always runs even if the
// deadline has already passed" (bounded-run.test.ts's own title for it) is
// TRUE of this file's runRefreshWave by construction — `started > 0` is
// checked with `&&` BEFORE `now() >= deadline`, so the very first claim of
// EVERY invocation is unconditional, deadline or no. The deadline-interrupt
// test above already proves the observable half of this (processed:5, never
// 0, under real deadline pressure); forcing the FULLY degenerate case — a
// deadline that expired before even the first wave's first claim — against
// the real Pregel scheduler used above turned out to be a timing race this
// file cannot control from outside (LangGraph's own task-dispatch machinery
// reads Date.now() an unpredictable number of times before any mocked
// company call runs, so no reliable point exists to "jump" a fake clock
// between the deadline computation and the first claim check). A structural
// check on the guard itself is the honest substitute — it fails loudly if a
// future edit ever reorders the `&&` and lets a deadline block the very
// first claim, reintroducing the processed:0-forever hang this whole file
// exists to prevent.
describe('runRefreshWave — the first claim is unconditional', () => {
  it('checks `started > 0` before `now() >= deadline`, so a deadline already in the past can never block the first claim', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'lib/graph/refresh.ts'), 'utf8')
    expect(src).toMatch(/if\s*\(\s*started > 0\s*&&\s*now\(\) >= deadline\s*\)\s*return/)
  })
})

describe('getRefreshDeadlineInterrupt', () => {
  it('returns null for a normal (non-interrupted) result', () => {
    expect(getRefreshDeadlineInterrupt({ results: [], totals: {}, total: 0, processed: 0 })).toBeNull()
  })

  it('returns null for an interrupt payload of a different shape', () => {
    expect(getRefreshDeadlineInterrupt({ __interrupt__: [{ value: { kind: 'other' } }] })).toBeNull()
  })
})
