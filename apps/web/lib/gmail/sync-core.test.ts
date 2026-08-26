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

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => fakeDb,
}))
vi.mock('@/lib/interactions/store', () => ({
  recordInteraction: async () => null,
}))
vi.mock('./gmail-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gmail-api')>()
  return { ...actual, fetchGmailMessages: async () => [FIXED_MESSAGE] }
})
vi.mock('./classify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./classify')>()
  return { ...actual, parseEmailWithAI: async () => FIXED_PARSED }
})

import { runGmailSyncCore } from './sync-core'

const USER_ID = 'user-1'

function preferences() {
  return { gmail_sync: { scannedEmailIds: ['old-unrelated-id'] } }
}

describe('runGmailSyncCore — idempotency', () => {
  beforeEach(() => {
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
        apiKeys: { openrouter: 'fake-key' },
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
