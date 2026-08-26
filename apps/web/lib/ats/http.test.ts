import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertAllowedHostSuffix,
  backoffDelayMs,
  CELLO_USER_AGENT,
  CircuitBreaker,
  CircuitOpenError,
  fetchJson,
  fetchText,
  hostPolitenessState,
  HttpError,
  parseRetryAfterMs,
  resetPolitenessState,
  TokenBucket,
} from './http'

const realFetch = globalThis.fetch

// The per-host rate limiter and circuit breaker deliberately REMEMBER what a
// host told us last time — that memory is the whole point in production, and
// exactly what has to be cleared between tests so one test's 429 cannot slow
// down or trip the next one's host.
beforeEach(() => {
  resetPolitenessState()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('fetchJson retry parity (p-retry wired via lib/util/retry classifyError)', () => {
  it('a 429 then a 200 succeeds — one retry, both attempts hit fetch', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchJson<{ ok: boolean }>('https://example.com/jobs', {
      // Tiny backoff so the test doesn't wait out a real ~400ms delay.
      backoffBaseMs: 5,
      backoffCapMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a 402 does NOT retry — fails on the first attempt, surfaced as HttpError', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValue(new Response(null, { status: 402, statusText: 'Payment Required' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchJson('https://example.com/jobs', { backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toMatchObject({ status: 402 })
    await expect(
      fetchJson('https://example.com/jobs', { backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toBeInstanceOf(HttpError)

    // Two fetchJson() calls above, one fetch each — never a retry on 402.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('exhausts retries on a persistent 503 and throws the last HttpError', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValue(new Response(null, { status: 503, statusText: 'Service Unavailable' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchJson('https://example.com/jobs', { retries: 2, backoffBaseMs: 5, backoffCapMs: 10 })
    ).rejects.toMatchObject({ status: 503 })

    // retries: 2 => 3 total attempts (1 first try + 2 retries).
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('a network-level TypeError ("fetch failed") retries and then succeeds', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchJson<{ ok: boolean }>('https://example.com/jobs', {
      backoffBaseMs: 5,
      backoffCapMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an already-aborted caller signal stops retrying immediately, never calling fetch', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    await expect(
      fetchJson('https://example.com/jobs', { signal: controller.signal })
    ).rejects.toThrow('user cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The three transport capabilities the Workday and Personio adapters needed —
// a POST list call, a non-JSON body, and a per-tenant host — added without
// giving any of them a bare fetch() outside these guards.
describe('fetchJson — POST bodies (Workday)', () => {
  it('sends the method, the body and a JSON content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs', {
      method: 'POST',
      body: JSON.stringify({ limit: 20, offset: 0 }),
    })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"limit":20,"offset":0}')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    // Still never follows a redirect.
    expect(init.redirect).toBe('error')
  })

  it('defaults to GET with no body, exactly as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://example.com/jobs')

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })
})

describe('fetchText — non-JSON bodies (Personio XML)', () => {
  it('returns the raw body and keeps the retry policy', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(new Response('<workzag-jobs></workzag-jobs>', { status: 200, headers: { 'content-type': 'text/xml' } }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const xml = await fetchText('https://acme.jobs.personio.de/xml', { backoffBaseMs: 5, backoffCapMs: 10 })

    expect(xml).toBe('<workzag-jobs></workzag-jobs>')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("redirect: 'manual' turns a 3xx into a plain HttpError instead of a retried TypeError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 307, statusText: 'Temporary Redirect' }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(fetchText('https://acme.jobs.personio.de/xml', { redirect: 'manual' })).rejects.toMatchObject({
      status: 307,
    })
    // The point of the option: one request, not four.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })
})

describe('assertAllowedHostSuffix', () => {
  it('accepts a tenant subdomain of an allowed vendor domain', () => {
    expect(assertAllowedHostSuffix('https://hygraph.recruitee.com/api/offers/', ['.recruitee.com'])).toContain('hygraph')
    expect(assertAllowedHostSuffix('https://a.b.jobs.personio.de/xml', ['.jobs.personio.de'])).toBeTruthy()
  })

  it('rejects lookalikes, the bare domain, http and unparseable URLs', () => {
    // The whole point: a suffix must not be satisfiable by a different
    // registrable domain that merely ends in the same characters.
    expect(() => assertAllowedHostSuffix('https://evilrecruitee.com/api/offers/', ['.recruitee.com'])).toThrow(/untrusted/)
    expect(() => assertAllowedHostSuffix('https://recruitee.com/api/offers/', ['.recruitee.com'])).toThrow(/untrusted/)
    expect(() => assertAllowedHostSuffix('https://acme.recruitee.com.evil.io/', ['.recruitee.com'])).toThrow(/untrusted/)
    expect(() => assertAllowedHostSuffix('http://acme.recruitee.com/', ['.recruitee.com'])).toThrow(/HTTPS/)
    expect(() => assertAllowedHostSuffix('not a url', ['.recruitee.com'])).toThrow(/invalid URL/)
  })

  it('ignores a suffix that is not dot-anchored, so it can never widen past a vendor', () => {
    expect(() => assertAllowedHostSuffix('https://evilrecruitee.com/', ['recruitee.com'])).toThrow(/untrusted/)
  })
})

// ===========================================================================
// Politeness: identity, Retry-After, backoff, per-host limits, circuit breaker,
// conditional requests.
//
// Every test below is offline. Nothing here — and nothing in http.ts — is about
// getting past a site that has decided to refuse us; the point is to be a
// client that a provider never has a reason to refuse in the first place, and
// that hears "no" the first time it is said.
// ===========================================================================

describe('identity', () => {
  it('sends one honest, identifiable User-Agent with a contact URL, never a browser disguise', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://ident.example.com/a')
    await fetchJson('https://ident.example.com/b')

    const ua = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(ua['user-agent']).toBe(CELLO_USER_AGENT)
    // The identity must be STABLE across requests. A rotating User-Agent is
    // evasion, and it also makes us un-blockable and un-debuggable.
    const second = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(second['user-agent']).toBe(ua['user-agent'])

    expect(CELLO_USER_AGENT).toContain('+https://')
    expect(CELLO_USER_AGENT).not.toMatch(/Mozilla|AppleWebKit|Chrome|Safari/i)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads the delta-seconds form', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000)
    expect(parseRetryAfterMs('0')).toBe(0)
    expect(parseRetryAfterMs('  30  ')).toBe(30_000)
  })

  it('reads the HTTP-date form, which the old seconds-only parser silently dropped', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    const future = new Date(now + 45_000).toUTCString()
    expect(parseRetryAfterMs(future, now)).toBe(45_000)
  })

  it('clamps a date already in the past to 0 rather than going negative', () => {
    const now = Date.parse('2026-08-03T12:00:00Z')
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0)
  })

  it('returns null for anything it cannot read, instead of "retry immediately"', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
    expect(parseRetryAfterMs('   ')).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
    // Date.parse is happy to read these as dates in 2001 — the shape guard in
    // parseRetryAfterMs is what stops a malformed header becoming "go now".
    expect(parseRetryAfterMs('-5')).toBeNull()
    expect(parseRetryAfterMs('1.5')).toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('doubles per attempt and lands in the equal-jitter window [exp/2, exp]', () => {
    const at = (attempt: number, random: number) =>
      backoffDelayMs({ attempt, baseMs: 100, capMs: 100_000, random: () => random })

    expect(at(1, 0)).toBe(50)
    expect(at(1, 0.999)).toBe(100)
    expect(at(2, 0)).toBe(100)
    expect(at(2, 0.999)).toBe(200)
    expect(at(4, 0)).toBe(400)
    expect(at(4, 0.999)).toBe(800)
  })

  it('never exceeds the cap, however many attempts have failed', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = backoffDelayMs({ attempt, baseMs: 400, capMs: 8_000, random: () => 0.999 })
      expect(delay).toBeLessThanOrEqual(8_000)
    }
    expect(backoffDelayMs({ attempt: 20, baseMs: 400, capMs: 8_000, random: () => 0 })).toBe(4_000)
  })

  it('spreads real draws across the window — this is what de-synchronises a fleet', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 300; i++) {
      const delay = backoffDelayMs({ attempt: 3, baseMs: 100, capMs: 100_000 })
      // exp = 400 for attempt 3, so the window is [200, 400].
      expect(delay).toBeGreaterThanOrEqual(200)
      expect(delay).toBeLessThanOrEqual(400)
      seen.add(delay)
    }
    // A fixed schedule would produce exactly one value, and 436 clients would
    // all come back at the same instant.
    expect(seen.size).toBeGreaterThan(10)
  })

  it('lets a server-stated Retry-After override the schedule and even the cap', () => {
    const delay = backoffDelayMs({ attempt: 1, baseMs: 400, capMs: 8_000, retryAfterMs: 30_000 })
    expect(delay).toBeGreaterThanOrEqual(30_000)
    // Obeyed to the second, plus a small random spread so a fleet told the same
    // number does not return in lockstep.
    expect(delay).toBeLessThan(30_500)
  })

  it('ignores a Retry-After shorter than the backoff we already owe', () => {
    const delay = backoffDelayMs({ attempt: 3, baseMs: 1_000, capMs: 30_000, retryAfterMs: 10, random: () => 0 })
    expect(delay).toBe(2_000)
  })
})

describe('TokenBucket', () => {
  it('lets a burst through, then meters at the configured rate', () => {
    let nowMs = 0
    const bucket = new TokenBucket({ ratePerSec: 2, burst: 3, now: () => nowMs })

    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(0)
    // Burst spent: at 2/s the next caller waits half a second, the one after a
    // full second — reservations queue instead of stampeding.
    expect(bucket.reserve()).toBe(500)
    expect(bucket.reserve()).toBe(1_000)
  })

  it('refills over time, capped at the burst size', () => {
    let nowMs = 0
    const bucket = new TokenBucket({ ratePerSec: 2, burst: 3, now: () => nowMs })
    bucket.reserve()
    bucket.reserve()
    bucket.reserve()

    nowMs = 1_000 // +2 tokens
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(500)

    nowMs = 60_000 // long idle: refill stops at the burst size, not 120 tokens
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(0)
    expect(bucket.reserve()).toBe(500)
  })

  it('halves the rate on a pace complaint and drains the remaining burst', () => {
    let nowMs = 0
    const bucket = new TokenBucket({ ratePerSec: 8, burst: 20, minRatePerSec: 1, now: () => nowMs })
    expect(bucket.reserve()).toBe(0)

    bucket.penalise()
    expect(bucket.ratePerSec).toBe(4)
    // Credit we were just told we do not have must not still be spendable.
    expect(bucket.reserve()).toBe(250)

    bucket.penalise()
    expect(bucket.ratePerSec).toBe(2)
    bucket.penalise()
    bucket.penalise()
    expect(bucket.ratePerSec).toBe(1) // floor, not zero — never a full stop
  })

  it('creeps the rate back up on success, and never above the default', () => {
    const bucket = new TokenBucket({ ratePerSec: 4, burst: 4, minRatePerSec: 0.5, recoveryStepPerSec: 0.5 })
    bucket.penalise()
    bucket.penalise()
    expect(bucket.ratePerSec).toBe(1)

    bucket.reward()
    expect(bucket.ratePerSec).toBe(1.5)
    for (let i = 0; i < 50; i++) bucket.reward()
    expect(bucket.ratePerSec).toBe(4)
  })
})

describe('CircuitBreaker', () => {
  const build = (nowRef: { ms: number }) =>
    new CircuitBreaker({ threshold: 3, cooldownMs: 1_000, now: () => nowRef.ms })

  it('stays closed while a host is merely unlucky, and a success clears the streak', () => {
    const now = { ms: 0 }
    const breaker = build(now)

    breaker.recordRefusal()
    breaker.recordRefusal()
    expect(breaker.currentState()).toBe('closed')
    expect(breaker.allowRequest()).toBe(true)

    breaker.recordSuccess()
    expect(breaker.refusalStreak).toBe(0)

    breaker.recordRefusal()
    breaker.recordRefusal()
    expect(breaker.currentState()).toBe('closed')
  })

  it('opens after the threshold and refuses to call the host during the cool-down', () => {
    const now = { ms: 0 }
    const breaker = build(now)

    breaker.recordRefusal()
    breaker.recordRefusal()
    breaker.recordRefusal()

    expect(breaker.currentState()).toBe('open')
    expect(breaker.allowRequest()).toBe(false)
    expect(breaker.cooldownRemainingMs()).toBe(1_000)

    now.ms = 999
    expect(breaker.allowRequest()).toBe(false)
  })

  it('does not extend the cool-down for refusals that were already in flight', () => {
    const now = { ms: 0 }
    const breaker = build(now)
    breaker.recordRefusal()
    breaker.recordRefusal()
    breaker.recordRefusal()
    expect(breaker.cooldownRemainingMs()).toBe(1_000)

    // Five more concurrent requests land after the trip. Six concurrent 429s
    // must not turn a one-second pause into a minute.
    for (let i = 0; i < 5; i++) breaker.recordRefusal()
    expect(breaker.cooldownRemainingMs()).toBe(1_000)
  })

  it('admits exactly one probe when the cool-down elapses, and closes if it succeeds', () => {
    const now = { ms: 0 }
    const breaker = build(now)
    breaker.recordRefusal()
    breaker.recordRefusal()
    breaker.recordRefusal()

    now.ms = 1_000
    expect(breaker.currentState()).toBe('half-open')
    expect(breaker.allowRequest()).toBe(true)
    // Half-open means ONE probe, not a fresh flood at a host still recovering.
    expect(breaker.allowRequest()).toBe(false)

    breaker.recordSuccess()
    expect(breaker.currentState()).toBe('closed')
    expect(breaker.allowRequest()).toBe(true)
    expect(breaker.cooldownRemainingMs()).toBe(0)
  })

  it('re-opens with a doubled cool-down when the probe is refused again', () => {
    const now = { ms: 0 }
    const breaker = build(now)
    breaker.recordRefusal()
    breaker.recordRefusal()
    breaker.recordRefusal()

    now.ms = 1_000
    expect(breaker.allowRequest()).toBe(true)
    breaker.recordRefusal()

    expect(breaker.currentState()).toBe('open')
    expect(breaker.cooldownRemainingMs()).toBe(2_000)

    now.ms = 3_000
    expect(breaker.allowRequest()).toBe(true)
    breaker.recordRefusal()
    expect(breaker.cooldownRemainingMs()).toBe(4_000)
  })

  it('honours a long Retry-After as the cool-down floor, up to the ceiling', () => {
    const now = { ms: 0 }
    const breaker = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 1_000,
      maxCooldownMs: 60_000,
      now: () => now.ms,
    })

    breaker.recordRefusal(30_000)
    expect(breaker.cooldownRemainingMs()).toBe(30_000)

    const capped = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, maxCooldownMs: 60_000, now: () => now.ms })
    capped.recordRefusal(6 * 60 * 60 * 1000)
    expect(capped.cooldownRemainingMs()).toBe(60_000)
  })

  it('hands back the probe slot when the caller abandons the request', () => {
    const now = { ms: 0 }
    const breaker = build(now)
    breaker.recordRefusal()
    breaker.recordRefusal()
    breaker.recordRefusal()

    now.ms = 1_000
    expect(breaker.allowRequest()).toBe(true)
    breaker.recordAbandoned() // our own cancel is not evidence about the host
    expect(breaker.allowRequest()).toBe(true)
  })
})

describe('per-host circuit breaker, end to end', () => {
  it('stops calling a host that keeps refusing, and says so', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 403, statusText: 'Forbidden' })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    for (let i = 0; i < 5; i++) {
      await expect(fetchJson('https://blocked.example.com/jobs', { retries: 0 })).rejects.toMatchObject({
        status: 403,
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(5)

    // The sixth call never reaches the network: we were told no, five times.
    await expect(fetchJson('https://blocked.example.com/jobs', { retries: 0 })).rejects.toBeInstanceOf(
      CircuitOpenError
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)

    const state = hostPolitenessState('blocked.example.com')
    expect(state?.circuit).toBe('open')
    expect(state?.refusalStreak).toBe(5)
    expect(state?.cooldownRemainingMs).toBeGreaterThan(0)
  })

  it('a CircuitOpenError is not retried — re-asking a host that said no is the bug', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 429, statusText: 'Too Many Requests' })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    for (let i = 0; i < 5; i++) {
      await expect(
        fetchJson('https://ratelimited.example.com/jobs', { retries: 0, sleep: async () => {} })
      ).rejects.toMatchObject({ status: 429 })
    }
    fetchMock.mockClear()

    await expect(
      fetchJson('https://ratelimited.example.com/jobs', { retries: 3, sleep: async () => {} })
    ).rejects.toBeInstanceOf(CircuitOpenError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a 404 is a host talking to us happily, and never trips the breaker', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // A board token that does not exist is the most common non-200 in this
    // codebase. If it counted as a refusal, one bad token per company would
    // take the whole provider offline for everyone.
    for (let i = 0; i < 8; i++) {
      await expect(fetchJson('https://notfound.example.com/jobs', { retries: 0 })).rejects.toMatchObject({
        status: 404,
      })
    }

    expect(fetchMock).toHaveBeenCalledTimes(8)
    expect(hostPolitenessState('notfound.example.com')?.circuit).toBe('closed')
    expect(hostPolitenessState('notfound.example.com')?.refusalStreak).toBe(0)
  })
})

describe('429 and Retry-After', () => {
  it('waits at least as long as the server asked before retrying', async () => {
    const waits: number[] = []
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '2' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchJson<{ ok: boolean }>('https://slowdown.example.com/jobs', {
      backoffBaseMs: 10,
      backoffCapMs: 20,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    expect(result).toEqual({ ok: true })
    // The backoff obeys "2 seconds" rather than our own 10ms schedule…
    expect(waits[0]).toBeGreaterThanOrEqual(2_000)
    expect(waits[0]).toBeLessThan(2_500)
    // …and the 429 also tightened the per-host rate, so the retry itself is
    // metered rather than fired the instant the backoff ends.
    expect(waits.length).toBe(2)
    expect(waits[1]).toBeGreaterThan(0)
    expect(hostPolitenessState('slowdown.example.com')!.ratePerSec).toBeLessThan(10)
  })

  it('does not hold a request open for an hours-long Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(null, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '3600' } })
        )
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchJson('https://comeback.example.com/jobs', { retries: 3, sleep: async () => {} })
    ).rejects.toMatchObject({ status: 429 })

    // One request, not four: the wait is served by the host's cool-down, not by
    // a serverless function sleeping through the rest of its budget.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exposes the parsed Retry-After on the error, in ms and in seconds', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '45' } }))
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const err = await fetchJson('https://retryafter.example.com/jobs', { retries: 0 }).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).retryAfterMs).toBe(45_000)
    expect((err as HttpError).retryAfter).toBe(45)
  })
})

describe('per-host concurrency', () => {
  it('never has more than a handful of requests in flight to one host', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const releases: Array<() => void> = []

    const fetchMock = vi.fn().mockImplementation(() => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          inFlight -= 1
          resolve(jsonResponse({ ok: true }))
        })
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const calls = Array.from({ length: 12 }, () => fetchJson('https://busy.example.com/jobs'))
    let finished = false
    const all = Promise.all(calls).then((values) => {
      finished = true
      return values
    })

    // Let the gate admit whatever it will, release everything it admitted, and
    // repeat until the whole batch has drained.
    for (let i = 0; i < 200 && !finished; i++) {
      await new Promise((r) => setTimeout(r, 1))
      while (releases.length > 0) releases.shift()!()
    }
    await all

    expect(fetchMock).toHaveBeenCalledTimes(12)
    // 436 companies sharing one provider must not become 436 open sockets.
    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(maxInFlight).toBeGreaterThan(1)
  })
})

describe('conditional requests (ETag / If-Modified-Since)', () => {
  it('revalidates with If-None-Match and serves the cached body on a 304', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: ['a'] }, { headers: { etag: 'W/"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await fetchJson<{ jobs: string[] }>('https://etag.example.com/jobs')
    const second = await fetchJson<{ jobs: string[] }>('https://etag.example.com/jobs')

    expect(first).toEqual({ jobs: ['a'] })
    expect(second).toEqual({ jobs: ['a'] })

    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(firstHeaders['if-none-match']).toBeUndefined()
    expect(secondHeaders['if-none-match']).toBe('W/"v1"')
  })

  it('revalidates with If-Modified-Since when that is the only validator offered', async () => {
    const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT'
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }, { headers: { 'last-modified': lastModified } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://lastmod.example.com/jobs')
    await fetchJson('https://lastmod.example.com/jobs')

    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(secondHeaders['if-modified-since']).toBe(lastModified)
  })

  it('sends no conditional headers when the provider offered no validator', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ jobs: [] })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://novalidator.example.com/jobs')
    await fetchJson('https://novalidator.example.com/jobs')

    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(secondHeaders['if-none-match']).toBeUndefined()
    expect(secondHeaders['if-modified-since']).toBeUndefined()
  })

  it('never revalidates a POST, whose body is not part of the cache key', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ total: 0 }, { headers: { etag: 'W/"v1"' } })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const opts = { method: 'POST' as const, body: '{"offset":0}' }
    await fetchJson('https://post.example.com/jobs', opts)
    await fetchJson('https://post.example.com/jobs', opts)

    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(secondHeaders['if-none-match']).toBeUndefined()
  })

  it('can be opted out of per call', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ jobs: [] }, { headers: { etag: 'W/"v1"' } })))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://optout.example.com/jobs')
    await fetchJson('https://optout.example.com/jobs', { conditional: false })

    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(secondHeaders['if-none-match']).toBeUndefined()
  })

  it('keeps JSON and text fetches of one URL in separate cache entries', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [] }, { headers: { etag: 'W/"json"' } }))
      .mockResolvedValueOnce(new Response('<jobs/>', { status: 200, headers: { etag: 'W/"xml"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchJson('https://both.example.com/board')
    await fetchText('https://both.example.com/board')
    const again = await fetchText('https://both.example.com/board')

    expect(again).toBe('<jobs/>')
    const thirdHeaders = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>
    // The XML validator, not the JSON one — the same URL can legitimately
    // answer differently depending on what we asked it to Accept.
    expect(thirdHeaders['if-none-match']).toBe('W/"xml"')
  })
})
