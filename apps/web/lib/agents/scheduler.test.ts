import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keys = vi.hoisted(() => ({ profile: { row: { is_demo: false, demo_expires_at: null, demoColumnsAbsent: false } as Record<string, unknown> | null } }))
vi.mock('@/lib/harness/keys', () => ({ readProfileForDemoGuards: async () => ({ row: keys.profile.row, error: null }) }))
const vercel = vi.hoisted(() => ({ waitUntil: vi.fn() }))
vi.mock('@vercel/functions', () => ({ waitUntil: vercel.waitUntil }))

import { DemoThreadExpiredError, ThreadOwnershipError } from '@/lib/graph/invoke'
import {
  LEASE_MS,
  MAX_EXP_AHEAD_S,
  OldConversationError,
  claimLease,
  continueBody,
  continueUrl,
  ensureThread,
  fireContinue,
  releaseLease,
  renewLease,
  signContinue,
} from './scheduler'
import * as scheduler from './scheduler'
import { makeFakeAdmin } from './testing/fake-admin'

const SECRET = 'a-test-secret-that-is-long-enough'

beforeEach(() => {
  vi.stubEnv('AGENT_CONTINUE_SECRET', SECRET)
  keys.profile.row = { is_demo: false, demo_expires_at: null, demoColumnsAbsent: false }
  vercel.waitUntil.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function threads() {
  return makeFakeAdmin({
    graph_threads: [
      { thread_id: 't1', user_id: 'u1', surface: 'agent', conversation_id: null, expires_at: null, lease_until: null, lease_holder: null },
      { thread_id: 'old', user_id: 'u1', surface: 'copilot', conversation_id: null, expires_at: null },
      { thread_id: 'demo', user_id: 'u1', surface: 'agent', conversation_id: null, expires_at: '2020-01-01T00:00:00Z' },
    ],
  })
}

describe('the lease', () => {
  it('is claimed with one conditional update and nothing else', async () => {
    const a = threads()
    const lease = await claimLease(a, 't1')
    expect(lease).toMatchObject({ threadId: 't1' })
    expect(a.log).toEqual(['update graph_threads'])
    expect(new Date(a.tables.graph_threads[0].lease_until as string).getTime()).toBeGreaterThan(Date.now() + LEASE_MS - 5000)
  })

  it('a second claim fails while the first is held', async () => {
    const a = threads()
    expect(await claimLease(a, 't1')).not.toBeNull()
    expect(await claimLease(a, 't1')).toBeNull()
  })

  it('two claims at once give the lease to exactly one', async () => {
    const a = threads()
    const results = await Promise.all([claimLease(a, 't1'), claimLease(a, 't1'), claimLease(a, 't1')])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('an expired lease can be taken, and a held one cannot', async () => {
    const a = threads()
    const first = await claimLease(a, 't1', 1000, new Date(Date.now() - 60_000))
    expect(first).not.toBeNull()
    const second = await claimLease(a, 't1')
    expect(second).not.toBeNull()
    expect(second?.holder).not.toBe(first?.holder)
  })

  it('only the holder can renew or release', async () => {
    const a = threads()
    const lease = (await claimLease(a, 't1'))!
    expect(await renewLease(a, lease)).toBe(true)
    expect(await renewLease(a, { threadId: 't1', holder: 'someone-else' })).toBe(false)
    await releaseLease(a, { threadId: 't1', holder: 'someone-else' })
    expect(a.tables.graph_threads[0].lease_until).not.toBeNull()
    await releaseLease(a, lease)
    expect(a.tables.graph_threads[0].lease_until).toBeNull()
    expect(await claimLease(a, 't1')).not.toBeNull()
  })

  it('never claims another thread', async () => {
    const a = threads()
    await claimLease(a, 't1')
    expect(a.tables.graph_threads[1].lease_until ?? null).toBeNull()
  })
})

describe('the signed continue request', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z')

  it('signs the exact body, with an expiry five minutes out', () => {
    const body = continueBody({ reason: 'slice', thread_id: 't1' }, NOW)
    expect(JSON.parse(body)).toEqual({ reason: 'slice', thread_id: 't1', exp: Math.floor(NOW / 1000) + MAX_EXP_AHEAD_S })
    expect(signContinue(body)).toBe(signContinue(body))
    expect(signContinue(body)).not.toBe(signContinue(body.replace('t1', 't2')))
    expect(signContinue(body, 'a-different-secret-entirely')).not.toBe(signContinue(body))
  })

  it('refuses to sign without a real secret', () => {
    vi.stubEnv('AGENT_CONTINUE_SECRET', 'short')
    expect(() => signContinue('x')).toThrow(/AGENT_CONTINUE_SECRET/)
  })

  it('is hex HMAC-SHA256 over the body text, the way the database sweeper signs', () => {
    const body = '{"reason": "due", "scheduled_task_id": "abc", "exp": 1790000000}'
    expect(signContinue(body, 'k'.repeat(16))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not check requests: the continue endpoint is the clock\'s', () => {
    expect(scheduler).not.toHaveProperty('verifyContinue')
  })
})

describe('firing a continuation', () => {
  it('posts the signed body to the configured url', async () => {
    vi.stubEnv('AGENT_CONTINUE_URL', 'http://example.test/api/agent/continue')
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 202 }))
    await fireContinue({ reason: 'slice', thread_id: 't1' }, fetchImpl as never)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }]
    expect(url).toBe('http://example.test/api/agent/continue')
    expect(verifyContinue(init.body, init.headers['x-cello-signature'])).toMatchObject({ ok: true, payload: { reason: 'slice', thread_id: 't1' } })
  })

  it('uses waitUntil on Vercel so the response is not held', async () => {
    vi.stubEnv('VERCEL', '1')
    const fetchImpl = vi.fn(async () => new Response('ok'))
    await fireContinue({ reason: 'slice', thread_id: 't1' }, fetchImpl as never)
    expect(vercel.waitUntil).toHaveBeenCalledTimes(1)
  })

  it('never throws when the request fails: the sweeper is the backstop', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused')
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(fireContinue({ reason: 'stale', thread_id: 't1' }, fetchImpl as never)).resolves.toBeUndefined()
  })

  it('defaults the url to this app', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://cello.test/')
    expect(continueUrl()).toBe('https://cello.test/api/agent/continue')
  })
})

describe('threads', () => {
  it('returns the persons own thread, and treats a missing or foreign one the same way', async () => {
    const a = threads()
    expect((await ensureThread(a, 'u1', { surface: 'agent', threadId: 't1' })).thread_id).toBe('t1')
    await expect(ensureThread(a, 'u2', { surface: 'agent', threadId: 't1' })).rejects.toBeInstanceOf(ThreadOwnershipError)
    await expect(ensureThread(a, 'u1', { surface: 'agent', threadId: 'nope' })).rejects.toBeInstanceOf(ThreadOwnershipError)
  })

  it('leaves a conversation from the earlier Copilot readable but does not resume it', async () => {
    await expect(ensureThread(threads(), 'u1', { surface: 'agent', threadId: 'old' })).rejects.toBeInstanceOf(OldConversationError)
  })

  it('refuses an expired demo thread', async () => {
    await expect(ensureThread(threads(), 'u1', { surface: 'agent', threadId: 'demo' })).rejects.toBeInstanceOf(DemoThreadExpiredError)
  })

  it('creates a thread for a conversation, and stamps a demo thread with its deadline', async () => {
    const a = threads()
    const created = await ensureThread(a, 'u1', { surface: 'agent', conversationId: 'c1' })
    expect(created).toMatchObject({ user_id: 'u1', surface: 'agent', conversation_id: 'c1', expires_at: null })
    keys.profile.row = { is_demo: true, demo_expires_at: '2099-01-01T00:00:00Z', demoColumnsAbsent: false }
    const demo = await ensureThread(a, 'u1', { surface: 'scheduled' })
    expect(demo.expires_at).toBe('2099-01-01T00:00:00Z')
  })
})
