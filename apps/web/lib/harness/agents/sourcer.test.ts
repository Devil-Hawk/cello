// Proves three things the ingest/keyword tests can't:
//   1. planBroadenStep — the pure round-planning function — is correctly
//      bounded and never touches a HARD targeting constraint (excludedCompanies
//      / excludedKeywords / functions / languages), independent of any I/O.
//   2. the `sourcer` agent's broaden-on-empty loop actually drives that plan
//      through multiple rounds, accumulates results, reports each step in
//      `notes`, is bounded even when nothing is ever found, and NEVER lets a
//      user's excludedCompanies/excludedKeywords lapse across rounds.
//   3. the LAST rung (lib/search/job-discovery.ts's open-web search) only
//      fires when the free keyless sources above are still short after every
//      applicable broaden step, uses the widest targeting/intent state
//      reached by that ladder, is reported in `notes` like every other round,
//      and still respects the user's hard exclusions.
//
// lib/sources and lib/search/job-discovery (real network + real Supabase
// writes) are both mocked — this test makes zero network calls and zero DB
// writes, same rule as bulk_matcher.test.ts's in-memory fake AdminClient.
// sanitizeLeads (lib/sources/util.ts) is NOT mocked — sourcer.ts calls it
// directly (not through the mocked '../../sources' barrel) on web-search
// leads, so this test's web-search fixtures use realistic titles that
// actually survive the real quality classifier, same as production leads
// would.

import { describe, expect, it, vi } from 'vitest'

const { queryAllSourcesMock, ingestLeadsMock, discoverJobsViaWebSearchMock } = vi.hoisted(() => ({
  queryAllSourcesMock: vi.fn(),
  ingestLeadsMock: vi.fn(),
  discoverJobsViaWebSearchMock: vi.fn(),
}))

vi.mock('../../sources', () => ({
  queryAllSources: queryAllSourcesMock,
  ingestLeads: ingestLeadsMock,
}))

vi.mock('../../search/job-discovery', () => ({
  discoverJobsViaWebSearch: discoverJobsViaWebSearchMock,
}))

import {
  BROADEN_STEP_ORDER,
  MAX_BROADEN_ROUNDS,
  planBroadenStep,
  sourcer,
  type BroadenState,
} from './sourcer'
import { EMPTY_TARGETING, type Targeting } from '../../targeting'
import { getRoleIntent } from '../../jobs/role-taxonomy'
import type { AdminClient, StepContext } from '../types'
import type { JobLead } from '../../sources'

// Every existing test below exercises the free-aggregator ladder only and
// doesn't care about the web-search rung — default it to an obvious no-op
// ("nothing to search with") so none of them accidentally depend on it, and
// so none of them silently fall through to a real network call. Tests that
// DO care about the web-search rung override this per-test below.
const SKIPPED_WEB_SEARCH_RESULT = {
  queries: [] as string[],
  hits: 0,
  atsVerified: 0,
  livenessVerified: 0,
  dropped: 0,
  leads: [] as JobLead[],
  backend: 'none',
  notes: 'web_search: skipped (test default)',
}
discoverJobsViaWebSearchMock.mockResolvedValue(SKIPPED_WEB_SEARCH_RESULT)

// ---------------------------------------------------------------------------
// planBroadenStep — pure, no I/O
// ---------------------------------------------------------------------------

const sweAiMl = getRoleIntent('swe-ai-ml')!

describe('planBroadenStep', () => {
  it('is bounded to exactly 3 steps, matching MAX_BROADEN_ROUNDS', () => {
    expect(BROADEN_STEP_ORDER).toEqual(['adjacent-titles', 'relax-location', 'relax-seniority'])
    expect(MAX_BROADEN_ROUNDS).toBe(3)
  })

  it('adjacent-titles is applicable only when an intent with adjacent titles is resolved', () => {
    const state: BroadenState = { targeting: EMPTY_TARGETING, allowAdjacent: false }
    expect(planBroadenStep('adjacent-titles', state, null).applicable).toBe(false)
    expect(planBroadenStep('adjacent-titles', state, sweAiMl).applicable).toBe(true)
    const already: BroadenState = { ...state, allowAdjacent: true }
    expect(planBroadenStep('adjacent-titles', already, sweAiMl).applicable).toBe(false)
  })

  it('relax-location is applicable only when a country or remoteOnly constraint is set', () => {
    const none: BroadenState = { targeting: EMPTY_TARGETING, allowAdjacent: false }
    expect(planBroadenStep('relax-location', none, null).applicable).toBe(false)

    const withCountry: BroadenState = {
      targeting: { ...EMPTY_TARGETING, countries: ['DE'] },
      allowAdjacent: false,
    }
    const plan = planBroadenStep('relax-location', withCountry, null)
    expect(plan.applicable).toBe(true)
    expect(plan.next.targeting.countries).toEqual([])
    expect(plan.next.targeting.remoteOnly).toBe(false)
  })

  it('relax-seniority is applicable only when a seniority constraint is set', () => {
    const withSeniority: BroadenState = {
      targeting: { ...EMPTY_TARGETING, seniority: ['senior'] },
      allowAdjacent: false,
    }
    const plan = planBroadenStep('relax-seniority', withSeniority, null)
    expect(plan.applicable).toBe(true)
    expect(plan.next.targeting.seniority).toEqual([])
  })

  it('NEVER touches excludedCompanies, excludedKeywords, functions, or languages, on any step', () => {
    const loaded: BroadenState = {
      targeting: {
        ...EMPTY_TARGETING,
        countries: ['DE'],
        remoteOnly: true,
        seniority: ['senior'],
        functions: ['engineering'],
        languages: ['en'],
        excludedCompanies: ['badco'],
        excludedKeywords: ['unpaid'],
      },
      allowAdjacent: false,
    }
    for (const stepId of BROADEN_STEP_ORDER) {
      const plan = planBroadenStep(stepId, loaded, sweAiMl)
      expect(plan.next.targeting.excludedCompanies).toEqual(['badco'])
      expect(plan.next.targeting.excludedKeywords).toEqual(['unpaid'])
      expect(plan.next.targeting.functions).toEqual(['engineering'])
      expect(plan.next.targeting.languages).toEqual(['en'])
    }
  })

  it('reports (never silently skips) a step that had nothing to relax', () => {
    const none: BroadenState = { targeting: EMPTY_TARGETING, allowAdjacent: false }
    const plan = planBroadenStep('relax-location', none, null)
    expect(plan.applicable).toBe(false)
    expect(plan.describe.toLowerCase()).toContain('skipped')
  })
})

// ---------------------------------------------------------------------------
// sourcer agent — mocked network/DB, real broaden-on-empty loop
// ---------------------------------------------------------------------------

function lead(overrides: Partial<JobLead>): JobLead {
  return {
    company: 'Acme',
    title: 'Untitled',
    url: 'https://acme.example/1',
    location: null,
    salary: null,
    description: '',
    source: 'themuse',
    externalId: overrides.url ?? 'acme-1',
    tags: [],
    ...overrides,
  }
}

function fakeAdmin(preferences: unknown): AdminClient {
  const builder = {
    select() {
      return builder
    },
    eq() {
      return builder
    },
    single() {
      return Promise.resolve({ data: { resume_text: null, preferences }, error: null })
    },
  }
  return { from: () => builder } as unknown as AdminClient
}

function fakeCtx(input: unknown, preferences: unknown): StepContext {
  return {
    userId: 'user-1',
    runId: 'test-run',
    stepLabel: 'source-jobs',
    agentType: 'sourcer',
    input,
    deps: {},
    admin: fakeAdmin(preferences),
    apiKeys: {},
    llm: async () => {
      throw new Error('sourcer must never call the LLM')
    },
    signal: new AbortController().signal,
  }
}

describe('sourcer — broaden-on-empty', () => {
  it('widens adjacent -> location -> seniority, accumulating and reporting each round', async () => {
    const targeting: Partial<Targeting> = {
      countries: ['DE'],
      remoteOnly: true,
      seniority: ['senior'],
    }

    queryAllSourcesMock
      .mockResolvedValueOnce({
        leads: [
          lead({ title: 'Software Engineer, AI/ML', url: 'u1', company: 'A' }),
          lead({ title: 'Senior AI Engineer', url: 'u2', company: 'B' }),
        ],
        perSource: { themuse: { found: 2 } },
      })
      .mockResolvedValueOnce({
        leads: [
          lead({ title: 'Data Scientist', url: 'u3', company: 'C' }),
          lead({ title: 'Research Scientist', url: 'u4', company: 'D' }),
          lead({ title: 'Backend Engineer', url: 'u5', company: 'E' }),
        ],
        perSource: { remoteok: { found: 3 } },
      })
      .mockResolvedValueOnce({
        leads: [
          lead({ title: 'MLOps Engineer', url: 'u6', company: 'F' }),
          lead({ title: 'LLM Engineer', url: 'u7', company: 'G' }),
          lead({ title: 'Applied Scientist', url: 'u8', company: 'H' }),
          lead({ title: 'AI Platform Engineer', url: 'u9', company: 'I' }),
        ],
        perSource: { arbeitnow: { found: 4 } },
      })
      .mockResolvedValueOnce({
        leads: [
          lead({ title: 'AI Engineer', url: 'u10', company: 'J' }),
          lead({ title: 'AI/ML Engineer', url: 'u11', company: 'K' }),
        ],
        perSource: { hackernews: { found: 2 } },
      })

    let jobCounter = 0
    ingestLeadsMock.mockImplementation(async (_admin: unknown, _userId: string, leads: JobLead[]) => ({
      jobIds: leads.map(() => `job-${++jobCounter}`),
      found: leads.length,
      inserted: leads.length,
      createdCompanies: leads.length,
      errors: [],
    }))

    const ctx = fakeCtx({ query: 'SWE - AI/ML', limit: 10 }, { targeting })
    const result = await sourcer(ctx)
    const output = result.output as { jobIds: string[]; found: number; inserted: number; notes?: string }

    // All 4 rounds ran (baseline + all 3 broaden steps applicable), and every
    // lead across every round was kept (in-role in round 1, adjacent once
    // allowed in round 2, in-role again in rounds 3-4).
    expect(queryAllSourcesMock).toHaveBeenCalledTimes(4)
    expect(output.jobIds).toHaveLength(11)
    expect(output.found).toBe(11)
    expect(output.inserted).toBe(11)

    // Every round's step is reported, never silent.
    expect(output.notes).toContain('intent=swe-ai-ml')
    expect(output.notes).toContain('broaden[adjacent-titles]: included adjacent titles')
    expect(output.notes).toContain('broaden[relax-location]: dropped location constraint')
    expect(output.notes).toContain('broaden[relax-seniority]: dropped seniority constraint')

    // Round 1 (baseline) queried with the full, unrelaxed targeting.
    const round1Query = queryAllSourcesMock.mock.calls[0][0]
    expect(round1Query.targeting.countries).toEqual(['DE'])
    expect(round1Query.targeting.remoteOnly).toBe(true)
    expect(round1Query.targeting.seniority).toEqual(['senior'])

    // Round 2 (adjacent-titles) widened the keyword list, targeting untouched.
    const round2Query = queryAllSourcesMock.mock.calls[1][0]
    expect(round2Query.keywords).toEqual(expect.arrayContaining(['data scientist', 'backend engineer']))
    expect(round2Query.targeting.countries).toEqual(['DE'])

    // Round 3 (relax-location) dropped country/remote, kept seniority.
    const round3Query = queryAllSourcesMock.mock.calls[2][0]
    expect(round3Query.targeting.countries).toEqual([])
    expect(round3Query.targeting.remoteOnly).toBe(false)
    expect(round3Query.targeting.seniority).toEqual(['senior'])

    // Round 4 (relax-seniority) dropped seniority too.
    const round4Query = queryAllSourcesMock.mock.calls[3][0]
    expect(round4Query.targeting.seniority).toEqual([])
  })

  it('stops widening as soon as the requested count is met (does not run every round)', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()

    queryAllSourcesMock.mockResolvedValueOnce({
      leads: [
        lead({ title: 'AI Engineer', url: 'v1' }),
        lead({ title: 'AI Engineer', url: 'v2' }),
        lead({ title: 'AI Engineer', url: 'v3' }),
      ],
      perSource: { themuse: { found: 3 } },
    })
    ingestLeadsMock.mockResolvedValueOnce({
      jobIds: ['job-a', 'job-b', 'job-c'],
      found: 3,
      inserted: 3,
      createdCompanies: 1,
      errors: [],
    })

    const ctx = fakeCtx({ query: 'AI Engineer', limit: 3 }, {})
    const result = await sourcer(ctx)
    const output = result.output as { jobIds: string[] }

    expect(queryAllSourcesMock).toHaveBeenCalledTimes(1) // baseline alone already met limit=3
    expect(output.jobIds).toHaveLength(3)
  })

  it('is bounded: never exceeds 1 + MAX_BROADEN_ROUNDS network rounds even when nothing is ever found', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()

    queryAllSourcesMock.mockResolvedValue({ leads: [], perSource: {} })
    ingestLeadsMock.mockResolvedValue({ jobIds: [], found: 0, inserted: 0, createdCompanies: 0, errors: [] })

    const targeting: Partial<Targeting> = { countries: ['DE'], remoteOnly: true, seniority: ['senior'] }
    const ctx = fakeCtx({ query: 'SWE - AI/ML', limit: 200 }, { targeting })
    const result = await sourcer(ctx)
    const output = result.output as { jobIds: string[] }

    expect(queryAllSourcesMock.mock.calls.length).toBeLessThanOrEqual(1 + MAX_BROADEN_ROUNDS)
    expect(queryAllSourcesMock).toHaveBeenCalledTimes(4)
    expect(output.jobIds).toHaveLength(0)
  })

  it('never lets excludedCompanies lapse across a broadened round', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()

    queryAllSourcesMock
      .mockResolvedValueOnce({
        leads: [
          lead({ title: 'AI Engineer', url: 'w1', company: 'Good Co' }),
          lead({ title: 'AI Engineer', url: 'w2', company: 'BadCo' }),
        ],
        perSource: { themuse: { found: 2 } },
      })
      .mockResolvedValueOnce({
        leads: [
          // "machine learning engineer" is one of ai-engineer's adjacentKeywords.
          lead({ title: 'Machine Learning Engineer', url: 'w3', company: 'Good Co 2' }),
          lead({ title: 'Machine Learning Engineer', url: 'w4', company: 'BadCo' }),
        ],
        perSource: { remoteok: { found: 2 } },
      })

    ingestLeadsMock.mockImplementation(async (_admin: unknown, _userId: string, leads: JobLead[]) => ({
      jobIds: leads.map((l) => `job-${l.externalId}`),
      found: leads.length,
      inserted: leads.length,
      createdCompanies: leads.length,
      errors: [],
    }))

    const targeting: Partial<Targeting> = { excludedCompanies: ['badco'] }
    const ctx = fakeCtx({ query: 'AI Engineer', limit: 100 }, { targeting })
    await sourcer(ctx)

    // Both rounds ran (adjacent-titles is applicable for ai-engineer;
    // relax-location/relax-seniority are not, since no such constraint was set).
    expect(queryAllSourcesMock).toHaveBeenCalledTimes(2)
    const round1Kept = ingestLeadsMock.mock.calls[0][2] as JobLead[]
    const round2Kept = ingestLeadsMock.mock.calls[1][2] as JobLead[]
    expect(round1Kept.map((l) => l.company)).toEqual(['Good Co'])
    expect(round2Kept.map((l) => l.company)).toEqual(['Good Co 2'])
  })
})

// ---------------------------------------------------------------------------
// sourcer — the LAST rung (web search), lib/search/job-discovery.ts mocked
// ---------------------------------------------------------------------------

function webLead(overrides: Partial<JobLead>): JobLead {
  return {
    company: 'Nova Robotics',
    title: 'AI Engineer',
    url: 'https://job-boards.greenhouse.io/novarobotics/jobs/1',
    location: 'Remote',
    salary: null,
    description: 'We are hiring an AI Engineer to build our LLM platform.',
    source: 'web_search',
    externalId: overrides.url ?? 'https://job-boards.greenhouse.io/novarobotics/jobs/1',
    tags: ['web_search'],
    ...overrides,
  }
}

describe('sourcer — last rung (web search)', () => {
  it('is skipped entirely once the free sources already met the limit', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()
    discoverJobsViaWebSearchMock.mockClear()

    queryAllSourcesMock.mockResolvedValueOnce({
      leads: [lead({ title: 'AI Engineer', url: 'z1' })],
      perSource: { themuse: { found: 1 } },
    })
    ingestLeadsMock.mockResolvedValueOnce({
      jobIds: ['job-z1'],
      found: 1,
      inserted: 1,
      createdCompanies: 1,
      errors: [],
    })

    const ctx = fakeCtx({ query: 'AI Engineer', limit: 1 }, {})
    await sourcer(ctx)

    expect(discoverJobsViaWebSearchMock).not.toHaveBeenCalled()
  })

  it('fires only once every free-source broaden round is exhausted, using the FINAL broadened state', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()
    discoverJobsViaWebSearchMock.mockClear()
    discoverJobsViaWebSearchMock.mockReset()

    // Every free-source round (baseline + all 3 broaden rounds) comes up empty.
    queryAllSourcesMock.mockResolvedValue({ leads: [], perSource: { themuse: { found: 0 } } })

    let jobCounter = 0
    ingestLeadsMock.mockImplementation(async (_admin: unknown, _userId: string, leads: JobLead[]) => ({
      jobIds: leads.map(() => `web-job-${++jobCounter}`),
      found: leads.length,
      inserted: leads.length,
      createdCompanies: leads.length,
      errors: [],
    }))

    discoverJobsViaWebSearchMock.mockResolvedValueOnce({
      queries: ['site:job-boards.greenhouse.io "AI Engineer" remote'],
      hits: 3,
      atsVerified: 1,
      livenessVerified: 0,
      dropped: 2,
      leads: [webLead({})],
      backend: 'duckduckgo',
      notes: 'web_search[backend=duckduckgo queries=4 hits=3 atsVerified=1 livenessVerified=0 dropped=2 leads=1]',
    })

    const targeting: Partial<Targeting> = { countries: ['DE'], remoteOnly: true, seniority: ['senior'] }
    const ctx = fakeCtx({ query: 'AI Engineer', limit: 5 }, { targeting })
    const result = await sourcer(ctx)
    const output = result.output as { jobIds: string[]; inserted: number; notes?: string }

    // Free sources ran baseline + all 3 broaden rounds (all applicable, all empty).
    expect(queryAllSourcesMock).toHaveBeenCalledTimes(4)
    expect(discoverJobsViaWebSearchMock).toHaveBeenCalledTimes(1)

    const call = discoverJobsViaWebSearchMock.mock.calls[0][0]
    expect(call.query).toBe('AI Engineer')
    expect(call.intent?.id).toBe('ai-engineer')
    // The widest state the ladder reached: location AND seniority relaxed.
    expect(call.targeting.countries).toEqual([])
    expect(call.targeting.remoteOnly).toBe(false)
    expect(call.targeting.seniority).toEqual([])
    // Still asking for the full remaining need (nothing found yet).
    expect(call.limit).toBe(5)
    expect(call.userId).toBe('user-1')
    expect(call.admin).toBeDefined()

    // The web-search lead was ingested and reported exactly like every other round.
    expect(output.jobIds).toHaveLength(1)
    expect(output.inserted).toBe(1)
    expect(output.notes).toContain('web_search[backend=duckduckgo')
    expect(output.notes).toContain('web-search[leads=1 kept=1 newJobs=1 total=1]')
  })

  it('still drops a web-search lead that violates the user\'s hard excludedCompanies', async () => {
    queryAllSourcesMock.mockReset()
    ingestLeadsMock.mockReset()
    discoverJobsViaWebSearchMock.mockReset()

    queryAllSourcesMock.mockResolvedValue({ leads: [], perSource: {} })
    ingestLeadsMock.mockImplementation(async (_admin: unknown, _userId: string, leads: JobLead[]) => ({
      jobIds: leads.map((l) => `job-${l.externalId}`),
      found: leads.length,
      inserted: leads.length,
      createdCompanies: leads.length,
      errors: [],
    }))
    discoverJobsViaWebSearchMock.mockResolvedValueOnce({
      queries: ['site:jobs.lever.co "AI Engineer"'],
      hits: 2,
      atsVerified: 2,
      livenessVerified: 0,
      dropped: 0,
      leads: [
        webLead({ url: 'https://jobs.lever.co/goodco/1', company: 'Good Co', externalId: 'https://jobs.lever.co/goodco/1' }),
        webLead({ url: 'https://jobs.lever.co/badco/2', company: 'BadCo', externalId: 'https://jobs.lever.co/badco/2' }),
      ],
      backend: 'duckduckgo',
      notes: 'web_search[backend=duckduckgo queries=4 hits=2 atsVerified=2 livenessVerified=0 dropped=0 leads=2]',
    })

    const targeting: Partial<Targeting> = { excludedCompanies: ['badco'] }
    const ctx = fakeCtx({ query: 'AI Engineer', limit: 50 }, { targeting })
    await sourcer(ctx)

    // Last ingestLeads call is the web-search round — only Good Co survived.
    const calls = ingestLeadsMock.mock.calls
    const lastKept = calls[calls.length - 1][2] as JobLead[]
    expect(lastKept.map((l) => l.company)).toEqual(['Good Co'])
    expect(lastKept.every((l) => l.source === 'web_search')).toBe(true)
  })
})
