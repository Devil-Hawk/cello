// POST /api/harness/autopilot's own logic: which profiles are opted in,
// the MAX_USERS_PER_TICK cap, and — the thing this file exists to pin — that
// every user gets a FRESH graph thread every tick (no `threadId` is ever
// passed to invokeGraphForUser). lib/graph/autopilot.ts's own entrypoint
// logic (caps, budget, journaling, the goal path) is invoke.ts/unit.ts's
// concern one layer down (see lib/graph/autopilot.test.ts) — this file mocks
// invokeGraphForUser entirely and proves only the ROUTE's own
// selection/capping/dispatch.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface ProfileRow {
  id: string
  full_name: string | null
  email: string | null
  resume_text: string | null
  preferences: Record<string, unknown> | null
}

let profiles: ProfileRow[]

const invokeGraphForUserMock = vi.fn()

class FakeQuery {
  constructor(private table: string) {}
  select(_cols?: string) {
    return this
  }
  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.resolve()).then(
      onfulfilled as (value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>,
      onrejected as (reason: unknown) => T2 | PromiseLike<T2>
    )
  }
  private resolve(): { data: unknown; error: unknown } {
    if (this.table === 'profiles') return { data: profiles, error: null }
    throw new Error(`route.test.ts: unexpected table "${this.table}"`)
  }
}

vi.mock('@/lib/harness/supabase-admin', () => ({
  createAdminClient: () => ({ from: (table: string) => new FakeQuery(table) }),
}))
vi.mock('@/lib/graph/invoke', () => ({
  invokeGraphForUser: (...args: unknown[]) => invokeGraphForUserMock(...args),
}))
vi.mock('@/lib/graph/autopilot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/autopilot')>()
  // Only autopilotTickGraph itself needs faking (it must never actually run
  // — invokeGraphForUser is mocked wholesale) — parseAutopilotConfig/
  // MAX_USERS_PER_TICK/USER_CONCURRENCY stay real so this file exercises the
  // ROUTE's use of the real kill-switch parsing and the real caps.
  return { ...actual, autopilotTickGraph: { __fake: 'autopilotTickGraph' } }
})

import { POST } from './route'

const SECRET = 'test-cron-secret'

function autopilotRequest() {
  return new NextRequest('http://localhost/api/harness/autopilot', {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
  })
}

function makeProfile(id: string, enabled: boolean): ProfileRow {
  return {
    id,
    full_name: null,
    email: null,
    resume_text: 'Some resume text.',
    preferences: enabled ? { autopilot: { enabled: true } } : { autopilot: { enabled: false } },
  }
}

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  profiles = []
  invokeGraphForUserMock.mockReset()
  invokeGraphForUserMock.mockResolvedValue({ threadId: 'irrelevant', result: { userId: 'irrelevant', message: 'ok' } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('POST /api/harness/autopilot — auth', () => {
  it('rejects a request without the correct CRON_SECRET', async () => {
    const response = await POST(new NextRequest('http://localhost/api/harness/autopilot', { method: 'POST' }))
    expect(response.status).toBe(401)
    expect(invokeGraphForUserMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/harness/autopilot — opt-in filtering', () => {
  it('only ticks profiles with preferences.autopilot.enabled === true', async () => {
    profiles = [makeProfile('on-1', true), makeProfile('off-1', false), makeProfile('on-2', true)]

    const response = await POST(autopilotRequest())
    const body = await response.json()

    expect(body.enabledUsers).toBe(2)
    expect(body.processed).toBe(2)
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(2)
    const tickedUserIds = invokeGraphForUserMock.mock.calls.map((c) => c[0].userId).sort()
    expect(tickedUserIds).toEqual(['on-1', 'on-2'])
  })

  it('caps the batch at MAX_USERS_PER_TICK even with more opted-in profiles', async () => {
    profiles = Array.from({ length: 15 }, (_, i) => makeProfile(`user-${i}`, true))

    const response = await POST(autopilotRequest())
    const body = await response.json()

    expect(body.enabledUsers).toBe(15)
    expect(body.processed).toBe(10) // MAX_USERS_PER_TICK
    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(10)
  })
})

describe('POST /api/harness/autopilot — fresh thread every tick', () => {
  it('never passes a threadId to invokeGraphForUser — every tick mints a brand-new graph thread', async () => {
    profiles = [makeProfile('user-fresh', true)]

    await POST(autopilotRequest())

    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(1)
    const call = invokeGraphForUserMock.mock.calls[0][0]
    expect(call.surface).toBe('autopilot')
    expect(call.threadId).toBeUndefined() // fresh thread, not a resume
    expect(call.input).toEqual({ profile: profiles[0] })
  })

  it('mints an independent fresh thread per user, not one shared thread for the whole tick', async () => {
    profiles = [makeProfile('user-a', true), makeProfile('user-b', true)]

    await POST(autopilotRequest())

    expect(invokeGraphForUserMock).toHaveBeenCalledTimes(2)
    for (const call of invokeGraphForUserMock.mock.calls) {
      expect(call[0].threadId).toBeUndefined()
    }
  })
})

describe('POST /api/harness/autopilot — per-user isolation', () => {
  it('one user erroring never blocks another user\'s tick, and reports the error honestly', async () => {
    profiles = [makeProfile('user-ok', true), makeProfile('user-bad', true)]
    invokeGraphForUserMock.mockImplementation(async ({ userId }: { userId: string }) => {
      if (userId === 'user-bad') throw new Error('thread ownership refused')
      return { threadId: 't-ok', result: { userId, message: 'ok' } }
    })

    const response = await POST(autopilotRequest())
    const body = await response.json()

    expect(body.results).toHaveLength(2)
    const bad = body.results.find((r: { userId: string }) => r.userId === 'user-bad')
    expect(bad.message).toContain('error: thread ownership refused')
    const ok = body.results.find((r: { userId: string }) => r.userId === 'user-ok')
    expect(ok.message).toBe('ok')
  })
})
