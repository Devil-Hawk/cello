import { describe, expect, it, vi } from 'vitest'
import { allowRedeemAttempt, clientKey, rateLimitKey } from './rate-limit'
import type { AdminClient } from '@/lib/harness/types'

const headers = (init: Record<string, string>) => new Headers(init)

function rpcAdmin(reply: { data?: unknown; error?: { message: string } | null } | (() => never)) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => {
    if (typeof reply === 'function') return reply()
    return { data: null, error: null, ...reply }
  })
  return { admin: { rpc } as unknown as AdminClient, rpc }
}

describe('rateLimitKey', () => {
  it('is 32 hex characters and never contains the address', () => {
    const key = rateLimitKey(headers({ 'x-real-ip': '203.0.113.77' }))
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).not.toContain('203')
    expect(key).not.toContain('113')
  })

  it('is stable per address and differs between addresses', () => {
    const a = rateLimitKey(headers({ 'x-real-ip': '203.0.113.77' }))
    expect(rateLimitKey(headers({ 'x-real-ip': '203.0.113.77' }))).toBe(a)
    expect(rateLimitKey(headers({ 'x-real-ip': '203.0.113.78' }))).not.toBe(a)
  })

  it('differs under a different server key', () => {
    vi.stubEnv('API_ENCRYPTION_KEY', 'a'.repeat(64))
    const a = rateLimitKey(headers({ 'x-real-ip': '203.0.113.77' }))
    vi.stubEnv('API_ENCRYPTION_KEY', 'b'.repeat(64))
    expect(rateLimitKey(headers({ 'x-real-ip': '203.0.113.77' }))).not.toBe(a)
    vi.unstubAllEnvs()
  })
})

describe('allowRedeemAttempt', () => {
  it('asks Postgres once, with the hashed key only', async () => {
    const { admin, rpc } = rpcAdmin({ data: true })
    const h = headers({ 'x-real-ip': '203.0.113.77' })
    expect(await allowRedeemAttempt(admin, h)).toEqual({ allowed: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('note_redeem_attempt', { p_client: rateLimitKey(h) })
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('203.0.113.77')
  })

  it('a refusal from the database is a refusal', async () => {
    const { admin } = rpcAdmin({ data: false })
    expect(await allowRedeemAttempt(admin, headers({}))).toEqual({ allowed: false, scope: 'limit' })
  })

  it('FAILS CLOSED when the database errors, answers nonsense or throws', async () => {
    expect(await allowRedeemAttempt(rpcAdmin({ error: { message: 'down' } }).admin, headers({}))).toEqual({ allowed: false, scope: 'unavailable' })
    expect(await allowRedeemAttempt(rpcAdmin({ data: 'yes' }).admin, headers({}))).toEqual({ allowed: false, scope: 'unavailable' })
    expect(
      await allowRedeemAttempt(
        rpcAdmin(() => {
          throw new Error('boom')
        }).admin,
        headers({})
      )
    ).toEqual({ allowed: false, scope: 'unavailable' })
  })
})

describe('clientKey', () => {
  it('prefers x-real-ip over x-forwarded-for', () => {
    expect(clientKey(headers({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('9.9.9.9')
  })

  it('falls back to the first x-forwarded-for entry, then to a shared bucket', () => {
    expect(clientKey(headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1')
    expect(clientKey(headers({}))).toBe('unattributed')
  })

  it('stripping headers does not buy a private bucket: unattributed callers share one', () => {
    expect(rateLimitKey(headers({}))).toBe(rateLimitKey(headers({ 'x-unrelated': 'x' })))
  })
})
