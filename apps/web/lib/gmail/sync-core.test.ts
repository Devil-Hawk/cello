// Pins the claim BUILDER-4's fix #4 makes (and app/api/gmail/sync/route.ts's
// own header repeats): re-running sync is idempotent — it dedupes on
// `metadata->>'gmail_message_id'` — even when the SAME Gmail message comes
// back as "new" a second time (e.g. its id fell out of the trimmed
// scannedEmailIds window, or the same search matched it again). Without the
// `existingActivity` guard in runGmailSyncCore, a second pass over the same
// message would resolve the same company/job/application and insert a
// second `activities` row for one real-world email.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailMessage } from './types'
import type { ParsedEmail } from './types'
import { TRACKED_FILTER } from '@/lib/companies/watchlist'

type Row = Record<string, any>

/** Minimal in-memory postgrest-like fake — just enough surface for sync-core's call shapes. */
function makeFakeDb() {
  const tables = new Map<string, Row[]>()

  function table(name: string): Row[] {
    let rows = tables.get(name)
    if (!rows) {
      rows = []
      tables.set(name, rows)
    }
    return rows
  }

  function getNested(row: Row, path: string): unknown {
    const arrowIdx = path.indexOf('->>')
    if (arrowIdx === -1) return row[path]
    const base = path.slice(0, arrowIdx)
    const key = path.slice(arrowIdx + 3)
    return row[base]?.[key]
  }

  function genId(t: string): string {
    const n = table(t).length
    return `${t}-${n}-${Math.random().toString(36).slice(2, 8)}`
  }

  function from(name: string) {
    const rows = table(name)
    let working: Row[] = rows
    let mode: 'select' | 'insert' | 'update' = 'select'
    let updatePatch: Row | null = null

    const api: any = {
      select() {
        return api
      },
      insert(payload: Row | Row[]) {
        mode = 'insert'
        const arr = Array.isArray(payload) ? payload : [payload]
        const withIds = arr.map((r) => ({ id: r.id ?? genId(name), ...r }))
        rows.push(...withIds)
        working = withIds
        return api
      },
      update(patch: Row) {
        mode = 'update'
        updatePatch = patch
        return api
      },
      eq(col: string, val: unknown) {
        if (mode === 'update') {
          for (const r of rows) if (getNested(r, col) === val) Object.assign(r, updatePatch)
          working = rows.filter((r) => getNested(r, col) === val)
        } else {
          working = working.filter((r) => getNested(r, col) === val)
        }
        return api
      },
      // Only the watchlist filter is used by sync-core; anything else must fail loudly.
      or(filter: string) {
        if (filter !== TRACKED_FILTER) throw new Error(`unexpected or() filter: ${filter}`)
        working = working.filter((r) => r.metadata?.suggested !== true)
        return api
      },
      not(col: string, _op: string, val: unknown) {
        working = working.filter((r) => getNested(r, col) !== val)
        return api
      },
      is(col: string, val: unknown) {
        working = working.filter((r) => getNested(r, col) === val)
        return api
      },
      limit(n: number) {
        working = working.slice(0, n)
        return api
      },
      maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
      single: async () =>
        working[0] ? { data: working[0], error: null } : { data: null, error: { message: 'no rows' } },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: working, error: null }).then(resolve, reject)
      },
    }
    return api
  }

  return { from, tables }
}

const FIXED_PARSED: ParsedEmail = {
  companyName: 'Acme Corp',
  companyDomain: 'acme.com',
  jobTitle: 'Backend Engineer',
  status: 'applied',
  careerPageUrl: null,
  confidence: 0.95,
  isJobRelated: true,
  reasoning: null,
  interviewDateTime: null,
}

const FIXED_MESSAGE: GmailMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  snippet: '',
  payload: {
    headers: [
      { name: 'from', value: 'Acme Corp <recruiter@acme.com>' },
      { name: 'subject', value: 'Thank you for applying to Acme Corp' },
    ],
    body: { data: '' },
  },
  internalDate: String(Date.now()),
}

let fakeDb: ReturnType<typeof makeFakeDb>
let mailbox: GmailMessage[] = [FIXED_MESSAGE]

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => fakeDb,
}))
vi.mock('@/lib/interactions/store', () => ({
  recordInteraction: async () => null,
}))
// Reply tracking has its own tests (lib/outreach/reply.test.ts); here it is only
// observed to be called with the sync's token.
const syncOutreachRepliesMock = vi.fn(async (..._args: unknown[]) => 0)
vi.mock('@/lib/outreach/reply', () => ({
  syncOutreachReplies: (...args: unknown[]) => syncOutreachRepliesMock(...args),
}))
vi.mock('./gmail-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gmail-api')>()
  return { ...actual, fetchGmailMessages: async () => mailbox }
})
// classify stays REAL: only the provider call and spend's DB writes are faked, so
// the test proves sync-core hands callLlm a userId and the call is metered.
const callOpenRouterMock = vi.fn()
vi.mock('@/lib/harness/providers/openrouter', () => ({
  callOpenRouter: (...args: unknown[]) => callOpenRouterMock(...args),
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
}))
const reserveSpendMock = vi.fn()
const settleSpendMock = vi.fn()
const RESERVATION = { id: 'res-1', userId: 'user-1', model: 'm', estimateUsd: 0.01 }
vi.mock('@/lib/harness/spend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/harness/spend')>()),
  reserveSpend: (...args: unknown[]) => reserveSpendMock(...args),
  settleSpend: (...args: unknown[]) => settleSpendMock(...args),
}))

import { runGmailSyncCore } from './sync-core'

const USER_ID = 'user-1'

function preferences() {
  return { gmail_sync: { scannedEmailIds: ['old-unrelated-id'] } }
}

describe('runGmailSyncCore — idempotency', () => {
  beforeEach(() => {
    callOpenRouterMock.mockReset().mockResolvedValue({
      content: JSON.stringify({
        isJobRelated: true,
        employerName: 'Acme Corp',
        employerDomain: 'acme.com',
        jobTitle: 'Backend Engineer',
        status: 'applied',
        careerPageUrl: null,
        interviewDateTime: null,
        confidence: 0.95,
        reasoning: null,
      }),
      tokensUsed: 600,
      promptTokens: 500,
      completionTokens: 100,
      model: 'google/gemini-2.0-flash-001',
    })
    reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
    settleSpendMock.mockReset().mockResolvedValue(undefined)
    fakeDb = makeFakeDb()
    fakeDb.tables.set('companies', [
      { id: 'company-1', user_id: USER_ID, name: 'Acme Corp', domain: 'acme.com', metadata: null },
    ])
    fakeDb.tables.set('profiles', [{ id: USER_ID, preferences: {} }])
  })

  it('double-running the same message produces exactly one activity, not two', async () => {
    const run = () =>
      runGmailSyncCore({
        db: fakeDb as any,
        userId: USER_ID,
        accessToken: 'fake-access-token',
        apiKeys: { openrouter: 'fake-key', userId: USER_ID },
        preferences: preferences(),
      })

    const first = await run()
    expect(first.createdApplications).toEqual(['Acme Corp'])
    expect(fakeDb.tables.get('activities')).toHaveLength(1)
    expect(fakeDb.tables.get('applications')).toHaveLength(1)
    expect(fakeDb.tables.get('jobs')).toHaveLength(1)

    // Same message reappears as "new" (e.g. it fell out of the trimmed
    // scannedEmailIds window) — it must resolve to the SAME job/application
    // and must NOT produce a second activities row.
    const second = await run()
    expect(second.createdApplications).toEqual([])
    expect(fakeDb.tables.get('activities')).toHaveLength(1)
    expect(fakeDb.tables.get('applications')).toHaveLength(1)
    expect(fakeDb.tables.get('jobs')).toHaveLength(1)
  })
})

describe('runGmailSyncCore: outreach replies', () => {
  it('checks the tracked outreach threads on every pass, whatever the job-email search returns', async () => {
    fakeDb = makeFakeDb()
    fakeDb.tables.set('profiles', [{ id: USER_ID, preferences: {} }])
    syncOutreachRepliesMock.mockClear()

    await runGmailSyncCore({
      db: fakeDb as any,
      userId: USER_ID,
      accessToken: 'fake-access-token',
      apiKeys: { userId: USER_ID },
      preferences: preferences(),
    })

    expect(syncOutreachRepliesMock).toHaveBeenCalledTimes(1)
    expect(syncOutreachRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, accessToken: 'fake-access-token' })
    )
  })
})

describe('runGmailSyncCore — LLM metering', () => {
  it('classifies through callLlm with the user id: budget checked and spend recorded per email', async () => {
    fakeDb = makeFakeDb()
    fakeDb.tables.set('profiles', [{ id: USER_ID, preferences: {} }])
    await runGmailSyncCore({
      db: fakeDb as any,
      userId: USER_ID,
      accessToken: 'fake-access-token',
      apiKeys: { openrouter: 'fake-key', userId: USER_ID },
      preferences: preferences(),
    })
    expect(callOpenRouterMock).toHaveBeenCalled()
    expect(reserveSpendMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: USER_ID, model: 'google/gemini-2.0-flash-001' }))
    expect(settleSpendMock).toHaveBeenCalledWith(expect.anything(), RESERVATION, { model: 'google/gemini-2.0-flash-001', promptTokens: 500, completionTokens: 100, costUsd: undefined })
  })
})

// What production's Gmail sync wrote into the companies table (2026-10-05): a
// sender display name, a job title, a mail relay, a non-employer. The model
// answered with these names and confidence >= 0.6, and each became a "company".
const JUNK_SENDERS: Array<{ label: string; from: string; employerName: string | null; employerDomain: string | null }> = [
  { label: 'recruiter display name', from: '"Jane Doe" <jane@point.com>', employerName: 'Jane Doe', employerDomain: 'point.com' },
  { label: 'job title as sender name', from: '"Machine Learning Engineer" <jobs@pitchbook.com>', employerName: 'Machine Learning Engineer', employerDomain: 'pitchbook.com' },
  { label: 'greenhouse-mail.io relay', from: 'Northwind Recruiting <no-reply@us.greenhouse-mail.io>', employerName: 'Northwind Recruiting', employerDomain: 'us.greenhouse-mail.io' },
  { label: 'rippling relay', from: 'Hiring <jobs@ats.rippling.com>', employerName: 'Rippling ATS', employerDomain: 'ats.rippling.com' },
  { label: 'bamboohr relay', from: 'Hiring <noreply@app.bamboohr.com>', employerName: 'BambooHR', employerDomain: 'app.bamboohr.com' },
  { label: 'icims relay', from: 'Talent <noreply@talent.icims.eu>', employerName: 'Talent', employerDomain: 'talent.icims.eu' },
  { label: 'oracle cloud relay', from: 'Recruiting <donotreply@workflow.mail.us2.cloud.oracle.com>', employerName: 'Recruiting', employerDomain: 'workflow.mail.us2.cloud.oracle.com' },
  { label: 'paycom relay', from: 'Careers <no-reply@msgint.paycomonline.com>', employerName: 'PAYCOM', employerDomain: 'msgint.paycomonline.com' },
  { label: 'teamtailor relay', from: 'Careers <no-reply@teamtailor-mail.com>', employerName: 'Teamtailor', employerDomain: 'teamtailor-mail.com' },
  { label: 'ticket draw application', from: 'FIFA <tickets@fifa.example>', employerName: 'FIFA World Cup', employerDomain: 'fifa.example' },
  { label: 'apartment rental application', from: 'Leasing <leasing@rentals.example>', employerName: 'Maple Court Apartments', employerDomain: 'rentals.example' },
  { label: 'job tool inbox', from: 'Tsenta <inbox@tsenta.example>', employerName: 'Tsenta', employerDomain: 'tsenta.example' },
]

function junkMessage(i: number, from: string): GmailMessage {
  return {
    id: `junk-${i}`,
    threadId: `junk-thread-${i}`,
    snippet: '',
    payload: {
      headers: [
        { name: 'from', value: from },
        { name: 'subject', value: 'Thank you for your application' },
      ],
      body: { data: '' },
    },
    internalDate: String(Date.now()),
  }
}

describe('runGmailSyncCore: email never creates companies', () => {
  beforeEach(() => {
    reserveSpendMock.mockReset().mockResolvedValue(RESERVATION)
    settleSpendMock.mockReset().mockResolvedValue(undefined)
    fakeDb = makeFakeDb()
    fakeDb.tables.set('companies', [
      { id: 'company-1', user_id: USER_ID, name: 'Acme Corp', domain: 'acme.com', metadata: null },
    ])
    fakeDb.tables.set('profiles', [{ id: USER_ID, preferences: {} }])
    mailbox = JUNK_SENDERS.map((j, i) => junkMessage(i, j.from))
  })

  it('creates zero companies and counts every unmatched job email (model path)', async () => {
    callOpenRouterMock.mockReset()
    for (const j of JUNK_SENDERS) {
      callOpenRouterMock.mockResolvedValueOnce({
        content: JSON.stringify({
          isJobRelated: true,
          employerName: j.employerName,
          employerDomain: j.employerDomain,
          jobTitle: 'Data Engineer',
          status: 'applied',
          careerPageUrl: null,
          interviewDateTime: null,
          confidence: 0.9,
          reasoning: null,
        }),
        tokensUsed: 600,
        promptTokens: 500,
        completionTokens: 100,
        model: 'google/gemini-2.0-flash-001',
      })
    }
    const result = await runGmailSyncCore({
      db: fakeDb as any,
      userId: USER_ID,
      accessToken: 'fake-access-token',
      apiKeys: { openrouter: 'fake-key', userId: USER_ID },
      preferences: preferences(),
    })
    expect(fakeDb.tables.get('companies')).toHaveLength(1)
    expect(fakeDb.tables.get('jobs') ?? []).toHaveLength(0)
    expect(fakeDb.tables.get('applications') ?? []).toHaveLength(0)
    expect(result.unmatchedEmployers).toBe(JUNK_SENDERS.length)
    expect('createdCompanies' in result).toBe(false)
  })

  it('creates zero companies on the pattern path too (no model key)', async () => {
    const result = await runGmailSyncCore({
      db: fakeDb as any,
      userId: USER_ID,
      accessToken: 'fake-access-token',
      apiKeys: { userId: USER_ID },
      preferences: preferences(),
    })
    expect(fakeDb.tables.get('companies')).toHaveLength(1)
    expect(result.unmatchedEmployers).toBe(result.unmatched.length)
  })

  it('still attaches activity to a tracked company, ignoring a suggested row of the same name', async () => {
    mailbox = [FIXED_MESSAGE]
    fakeDb.tables.set('companies', [
      // The suggested row comes LAST: the in-memory name map keeps the last row it sees, so only
      // the trackedOnly() filter in sync-core keeps this lead out of the match.
      { id: 'company-1', user_id: USER_ID, name: 'Acme Corp', domain: 'acme.com', metadata: null },
      { id: 'suggested-acme', user_id: USER_ID, name: 'Acme Corp', domain: 'acme.com', metadata: { suggested: true, source: 'gmail' } },
    ])
    callOpenRouterMock.mockReset().mockResolvedValue({
      content: JSON.stringify({
        isJobRelated: true,
        employerName: 'Acme Corp',
        employerDomain: 'acme.com',
        jobTitle: 'Backend Engineer',
        status: 'applied',
        careerPageUrl: null,
        interviewDateTime: null,
        confidence: 0.95,
        reasoning: null,
      }),
      tokensUsed: 600,
      promptTokens: 500,
      completionTokens: 100,
      model: 'google/gemini-2.0-flash-001',
    })
    const result = await runGmailSyncCore({
      db: fakeDb as any,
      userId: USER_ID,
      accessToken: 'fake-access-token',
      apiKeys: { openrouter: 'fake-key', userId: USER_ID },
      preferences: preferences(),
    })
    expect(fakeDb.tables.get('companies')).toHaveLength(2)
    expect(result.unmatchedEmployers).toBe(0)
    expect(result.createdApplications).toEqual(['Acme Corp'])
    expect(fakeDb.tables.get('jobs')?.[0].company_id).toBe('company-1')
    expect(fakeDb.tables.get('activities')).toHaveLength(1)
  })
})
