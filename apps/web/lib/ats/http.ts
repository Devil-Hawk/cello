// Shared HTTP transport for ATS adapters. Framework-free (global fetch only).
//
// ============================================================================
// THE POLITENESS CHARTER — read this before extending this file
// ============================================================================
// Everything below exists so Cello can READ public job listings for years
// without becoming a nuisance, and so that when a host says "slow down" or
// "no", we hear it the first time instead of the fortieth. The goal is
// RESILIENCE AND POLITENESS, not evasion.
//
// EXPLICITLY OUT OF SCOPE, AND NOT AN OVERSIGHT:
//   * Rotating, randomising or disguising our identity. There is exactly one
//     User-Agent (CELLO_USER_AGENT) and it names the product and a contact URL.
//     A rotating identity is evasion, and it also makes an outage impossible to
//     debug — the operator on the other side cannot tell us apart from a
//     botnet, and neither can we.
//   * Solving, bypassing or fingerprint-dodging CAPTCHAs and bot-detection
//     challenges.
//   * Anything whose purpose is to defeat a host that has decided to refuse
//     automation. If a host refuses, we back off, record the refusal, and stop
//     asking for a while (see CircuitBreaker). We do not fight it. A site that
//     does not want to be read is a site we do not read.
//
// Context for why the knobs are set where they are: the main funnel — the
// Greenhouse/Lever/Ashby/Workable/... adapters and the lib/sources feeds — is
// public JSON APIs behind CDNs that do not block. So the limits here are set to
// SMOOTH BURSTS and to OBEY REFUSALS QUICKLY, not to crawl slowly; throttling
// the product into uselessness would not be politeness, just breakage. The
// genuinely block-prone path is the generic career-page scraper, which lives in
// packages/scrapers and has its own, stricter policy in src/polite.py.
//
// ============================================================================
// WHAT THIS MODULE DOES, IN ORDER, FOR EVERY REQUEST
// ============================================================================
//   1. Identity          — one honest User-Agent, never rotated.
//   2. Circuit breaker   — is this host currently refusing us? If so, fail fast
//                          without spending a request or a retry.
//   3. Concurrency gate  — at most N requests in flight to one host.
//   4. Token bucket      — per-host rate limit, tightened on a 429 and relaxed
//                          again on sustained success (AIMD).
//   5. Conditional GET   — ETag / If-Modified-Since, so a refresh that finds
//                          nothing new costs the provider a 304 and costs us no
//                          parse. The cheapest possible politeness.
//   6. Retry             — p-retry drives the attempt loop and the shared
//                          classifyError() predicate decides what is worth
//                          retrying (lib/util/retry); the DELAY between
//                          attempts is computed here, by backoffDelayMs(), so
//                          that Retry-After can override the schedule and so
//                          the jitter shape is one we can test.
//
// Retry/backoff on a transient blip (timeout, dropped connection, 429/5xx) is
// delegated to `p-retry` — the same library lib/harness/llm.ts uses — with
// the shared classifyError() predicate (lib/util/retry) as its `shouldRetry`
// hook, so every HTTP source shares one retry policy instead of hand-rolling
// its own. A momentary failure against one board now gets a few retries
// before that source is dropped; a permanent failure (404, bad request)
// still fails on the first attempt, same as before.

import pRetry from 'p-retry'
import { isTransient } from '../util/retry'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The ONE identity Cello presents to every host it reads, in the shape a
 * well-behaved crawler uses: product/version plus a URL an operator can visit
 * to find out who is calling and how to reach us.
 *
 * Do not rotate this, do not randomise it, and do not impersonate a browser.
 * An operator who wants to rate-limit or block Cello must be able to do so by
 * matching this string — that is the deal that keeps us welcome. It is also the
 * only reason a 403 in a log is ever attributable to us.
 */
export const CELLO_USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number
  /** How long the server asked us to wait, in ms, from its Retry-After header. */
  readonly retryAfterMs: number | null

  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }

  /** Seconds view of {@link retryAfterMs}, kept for callers written against the
   *  original seconds-valued field. Prefer retryAfterMs — Retry-After can carry
   *  an HTTP-date, which has never been a whole number of seconds away. */
  get retryAfter(): number | null {
    return this.retryAfterMs === null ? null : this.retryAfterMs / 1000
  }
}

/**
 * Thrown instead of making a request when a host's circuit is open: it has
 * refused us repeatedly and we are serving out its cool-down.
 *
 * This is deliberately NOT classified as transient by lib/util/retry (no
 * status, no network code, and the message avoids the words classifyError
 * sniffs for), so it fails the caller immediately rather than being retried —
 * retrying "we already agreed to stop calling" is exactly the behaviour that
 * makes a client look like an attack.
 */
export class CircuitOpenError extends Error {
  readonly host: string
  /** Ms remaining on the cool-down when this was thrown. */
  readonly retryAfterMs: number

  constructor(host: string, retryAfterMs: number) {
    super(`ats: not calling ${host} — it refused us repeatedly; cooling down for ${Math.ceil(retryAfterMs / 1000)}s`)
    this.name = 'CircuitOpenError'
    this.host = host
    this.retryAfterMs = retryAfterMs
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FetchJsonOptions {
  /** Abort the request after this many ms (default 10s), per attempt. The
   *  clock starts AFTER the per-host gate lets the request through, so time
   *  spent being polite is never charged against the server's response time. */
  timeoutMs?: number
  /**
   * HTTP method (default GET). Workday's public board API is the odd one out:
   * its job list lives behind POST /wday/cxs/{tenant}/{site}/jobs with a JSON
   * body carrying the paging window, so read-only fetches are not all GETs.
   */
  method?: 'GET' | 'POST'
  /** Request body, already serialized. Only meaningful with method: 'POST'. */
  body?: string
  /**
   * Extra attempts on 429/5xx/network failure, on top of the first
   * (default 3, i.e. 4 total attempts — matches p-retry's `retries` option
   * name/semantics directly). Pass 0 to disable retries entirely (a single
   * request, old behavior).
   */
  retries?: number
  /** Base for the exponential backoff (default 400ms). See backoffDelayMs. */
  backoffBaseMs?: number
  /** Hard cap on any single computed backoff delay, in ms (default 8s). */
  backoffCapMs?: number
  headers?: Record<string, string>
  /**
   * Injectable sleep for the backoff and per-host rate-limit waits. Live again:
   * this transport now computes its own delays (see backoffDelayMs), so a
   * caller — or a test — can substitute the waiting. Left unset, waits use a
   * real, abort-aware timer.
   */
  sleep?: (ms: number) => Promise<void>
  /** Cancel/deadline signal — aborts the in-flight request and stops retrying. */
  signal?: AbortSignal
  /**
   * Opt out of ETag / If-Modified-Since revalidation for this call. On by
   * default for GET; never applied to POST (a cached body keyed by URL alone
   * would be wrong the moment the body changes).
   */
  conditional?: boolean
  /**
   * What to do about a 3xx (default 'error' — the redirect throws).
   *
   * 'manual' does NOT follow the redirect either: under undici it hands back
   * the 3xx response itself (status 307, `location` header unread), which
   * fetchOnce below turns into an HttpError — so the "the final host is one we
   * vetted" guarantee is identical. The difference is only in how the failure
   * is *reported*. 'error' surfaces as `TypeError: fetch failed`, which
   * classifyError() reads as transient and retries four times; a redirect is
   * how some boards say "no such tenant" (verified: an unknown Personio
   * subdomain answers 307 -> https://personio.com), and re-asking three more
   * times can never change that. 'manual' makes that miss one request instead
   * of four — which matters when 436 companies are probed on a schedule.
   */
  redirect?: 'error' | 'manual'
}

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------

/**
 * Parse a Retry-After header into milliseconds.
 *
 * RFC 9110 allows BOTH forms and real boards use both: `Retry-After: 120`
 * (delta-seconds) and `Retry-After: Wed, 21 Oct 2015 07:28:00 GMT` (HTTP-date).
 * The old implementation understood only the first and silently dropped the
 * second — which meant the one case where a server told us exactly when to come
 * back was the case we ignored.
 *
 * A date already in the past yields 0 ("you may retry now"), not a negative
 * number. Anything unparseable yields null, so callers fall back to their own
 * backoff rather than treating garbage as "retry immediately".
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null) return null
  const raw = value.trim()
  if (!raw) return null

  // delta-seconds. Deliberately strict: `Number('')` is 0 and `Number('1d')` is
  // NaN, but `Number(' 12 ')` is 12 — a bare integer is the only numeric form
  // the spec allows, so anything else falls through to the date parser.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }

  // HTTP-date. All three forms RFC 9110 permits (IMF-fixdate, the obsolete
  // RFC 850 form, and asctime) begin with a day name, so requiring a leading
  // letter is a cheap, sufficient discriminator — and a necessary one, because
  // Date.parse is far too willing: it reads "-5" as 1 May 2001 and "1.5" as
  // 5 Jan 2001. Without this guard a malformed header would silently become a
  // date in the past instead of the "I could not read this" that it is.
  if (!/^[A-Za-z]/.test(raw)) return null

  const when = Date.parse(raw)
  if (Number.isNaN(when)) return null
  return Math.max(0, when - now)
}

/** Pull a server-stated Retry-After (ms) off a caught error, if it carried one. */
function retryAfterMsOf(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Extra spread (ms) added on top of a server-stated Retry-After.
 *
 * Obeying Retry-After to the millisecond is what turns a fleet into a
 * thundering herd: 436 companies told "wait 5" all come back at exactly +5s and
 * re-trigger the same limit. So we wait AT LEAST what we were told, plus a
 * random sliver.
 */
const RETRY_AFTER_JITTER_MS = 500

export interface BackoffInput {
  /** 1-based: the delay before retry #attempt (attempt 1 = the first retry). */
  attempt: number
  /** Base of the exponential (default 400ms). */
  baseMs?: number
  /** Ceiling for the computed exponential term (default 8s). */
  capMs?: number
  /** A server-stated Retry-After in ms, if there was one. Acts as a FLOOR. */
  retryAfterMs?: number | null
  /** Injectable [0,1) source so jitter bounds are testable. */
  random?: () => number
}

/**
 * How long to wait before the next attempt.
 *
 * SHAPE: "equal jitter" — half the exponential term, plus a uniform random
 * draw over the other half, so the delay lands in [exp/2, exp).
 *
 * WHY NOT PLAIN EXPONENTIAL: every client that failed at the same instant would
 * retry at the same instant, which is how a brief provider hiccup turns into a
 * self-inflicted DDoS. Jitter de-synchronises them.
 *
 * WHY NOT FULL JITTER ([0, exp), the AWS default): a draw near zero means
 * retrying a 429 almost immediately. Spreading the herd is worth a lot;
 * spreading it by letting some members hammer instantly is not. Equal jitter
 * keeps a guaranteed floor while still spreading over a 2x window.
 *
 * WHY RETRY-AFTER OVERRIDES THE CAP: a server stating a number is not a hint to
 * be averaged with our guess, it is an instruction. The only thing we add is
 * jitter. Callers decide separately whether a very long Retry-After is worth
 * holding a request open for at all (see MAX_INLINE_RETRY_WAIT_MS).
 */
export function backoffDelayMs(input: BackoffInput): number {
  const attempt = Math.max(1, Math.floor(input.attempt))
  const baseMs = Math.max(0, input.baseMs ?? 400)
  const capMs = Math.max(0, input.capMs ?? 8_000)
  const random = input.random ?? Math.random

  const exponential = Math.min(capMs, baseMs * 2 ** (attempt - 1))
  const jittered = exponential / 2 + random() * (exponential / 2)

  const retryAfterMs = input.retryAfterMs
  if (retryAfterMs != null && retryAfterMs >= 0) {
    return Math.round(Math.max(jittered, retryAfterMs + random() * RETRY_AFTER_JITTER_MS))
  }
  return Math.round(jittered)
}

/**
 * Longest server-stated Retry-After we will sit through inside a request.
 *
 * Beyond this we do not retry at all: the refusal is recorded, the host's
 * circuit takes the stated cool-down, and the call fails now. Holding a
 * serverless function open for two minutes to honour "come back in 120s" burns
 * the whole refresh budget for one company — failing fast and letting the next
 * scheduled run pick it up is both cheaper and no less polite.
 */
const MAX_INLINE_RETRY_WAIT_MS = 30_000

// ---------------------------------------------------------------------------
// Per-host token bucket
// ---------------------------------------------------------------------------

export interface TokenBucketOptions {
  /** Steady-state requests per second. */
  ratePerSec: number
  /** How many requests may go out back-to-back after an idle period. */
  burst: number
  /** Floor the rate can be penalised down to (default 0.5/s). */
  minRatePerSec?: number
  /** How much a success adds back to the rate, per second (default 0.5). */
  recoveryStepPerSec?: number
  /** Injectable clock, in ms. */
  now?: () => number
}

/**
 * A per-host token bucket with AIMD rate control.
 *
 * RESERVING, NOT REJECTING: reserve() never refuses a request, it returns how
 * long the caller must wait first, and lets the token count go negative so that
 * concurrent callers queue in order instead of stampeding once tokens appear.
 * A rate limiter that dropped requests would just relocate the problem into
 * every adapter.
 *
 * AIMD (additive increase, multiplicative decrease) is the same shape TCP uses
 * for the same reason: halve on evidence of congestion, and only creep back up
 * on evidence that things are fine. A host that never complains keeps the full
 * default rate; a host that 429s gets progressively gentler treatment without
 * anyone having to hand-maintain a per-provider table.
 */
export class TokenBucket {
  readonly burst: number
  private readonly defaultRatePerSec: number
  private readonly minRatePerSec: number
  private readonly recoveryStepPerSec: number
  private readonly now: () => number
  private rate: number
  private tokens: number
  private lastRefillMs: number

  constructor(options: TokenBucketOptions) {
    this.defaultRatePerSec = Math.max(0.001, options.ratePerSec)
    this.burst = Math.max(1, options.burst)
    this.minRatePerSec = Math.max(0.001, options.minRatePerSec ?? 0.5)
    this.recoveryStepPerSec = Math.max(0, options.recoveryStepPerSec ?? 0.5)
    this.now = options.now ?? Date.now
    this.rate = this.defaultRatePerSec
    this.tokens = this.burst
    this.lastRefillMs = this.now()
  }

  /** Current allowance, in requests per second (moves with penalise/reward). */
  get ratePerSec(): number {
    return this.rate
  }

  private refill(): void {
    const nowMs = this.now()
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000)
    this.lastRefillMs = nowMs
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rate)
  }

  /**
   * Claim one token for a request. Returns the ms the caller must wait before
   * actually sending it — 0 when a token was available.
   */
  reserve(): number {
    this.refill()
    this.tokens -= 1
    if (this.tokens >= 0) return 0
    return Math.ceil((-this.tokens / this.rate) * 1000)
  }

  /**
   * The host told us we are going too fast: halve the rate (down to the floor)
   * and drain the remaining burst, so the very next request actually waits
   * rather than spending credit we have just been told we do not have.
   */
  penalise(): void {
    this.refill()
    this.rate = Math.max(this.minRatePerSec, this.rate / 2)
    this.tokens = Math.min(this.tokens, 0)
  }

  /** The host answered us normally: creep the rate back toward the default. */
  reward(): void {
    if (this.rate >= this.defaultRatePerSec) return
    this.rate = Math.min(this.defaultRatePerSec, this.rate + this.recoveryStepPerSec)
  }
}

// ---------------------------------------------------------------------------
// Per-host circuit breaker
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  /** Consecutive refusals that trip the circuit (default 5). */
  threshold?: number
  /** First cool-down, doubled on each re-trip (default 60s). */
  cooldownMs?: number
  /** Ceiling for a cool-down, however long a Retry-After asks for (default 15m). */
  maxCooldownMs?: number
  /** Injectable clock, in ms. */
  now?: () => number
}

/**
 * Stops calling a host that keeps refusing us.
 *
 * WHY THIS EXISTS: without it, 436 companies × 4 retries against a provider
 * that has decided to block us is 1700 requests that cannot succeed — the
 * budget is burned, and with every retry we look less like a job-search tool
 * and more like an attack. The correct response to "no" is to stop asking.
 *
 * WHAT COUNTS AS A REFUSAL (see isRefusalStatus): 403/451 — "we have decided to
 * block you"; 429 — "you are going too fast"; 503 — what a WAF and an
 * overloaded origin both return; and repeated network-level failures, which
 * mean there is nothing on the other end to talk to. Everything else the host
 * answers — including a 404 for a board token that does not exist, which is the
 * single most common non-200 in this codebase — RESETS the counter, because a
 * host answering 404 is a host that is perfectly happy to talk to us.
 *
 * STATES: closed → (threshold consecutive refusals) → open → (cool-down
 * elapses) → half-open, which admits exactly ONE probe. The probe succeeding
 * closes the circuit; the probe being refused re-opens it with double the
 * cool-down. Half-open is what stops a recovered host from waiting out a full
 * cool-down, and stops a still-broken one from receiving a fresh flood.
 */
export class CircuitBreaker {
  private readonly threshold: number
  private readonly baseCooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number

  private state: CircuitState = 'closed'
  private consecutiveRefusals = 0
  /** How many times this circuit has tripped without an intervening success. */
  private trips = 0
  private openedUntilMs = 0
  private probeInFlight = false

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = Math.max(1, options.threshold ?? 5)
    this.baseCooldownMs = Math.max(0, options.cooldownMs ?? 60_000)
    this.maxCooldownMs = Math.max(this.baseCooldownMs, options.maxCooldownMs ?? 15 * 60_000)
    this.now = options.now ?? Date.now
  }

  /** Current state, after settling any cool-down that has since elapsed. */
  currentState(): CircuitState {
    if (this.state === 'open' && this.now() >= this.openedUntilMs) {
      this.state = 'half-open'
      this.probeInFlight = false
    }
    return this.state
  }

  get refusalStreak(): number {
    return this.consecutiveRefusals
  }

  /** Ms left on the cool-down; 0 when the circuit is not holding anything back. */
  cooldownRemainingMs(): number {
    if (this.currentState() !== 'open') return 0
    return Math.max(0, this.openedUntilMs - this.now())
  }

  /**
   * Ask permission to make one request. When this returns true against a
   * half-open circuit it has consumed the single probe slot, which must be
   * handed back by one of the record* methods below.
   */
  allowRequest(): boolean {
    const state = this.currentState()
    if (state === 'closed') return true
    if (state === 'open') return false
    if (this.probeInFlight) return false
    this.probeInFlight = true
    return true
  }

  /** The host answered us. Clears the streak and closes the circuit. */
  recordSuccess(): void {
    this.state = 'closed'
    this.consecutiveRefusals = 0
    this.trips = 0
    this.probeInFlight = false
  }

  /**
   * The host refused us. `retryAfterMs`, when the host stated one, becomes the
   * floor for the cool-down — if it asks for ten minutes, it gets ten minutes.
   */
  recordRefusal(retryAfterMs: number | null = null): void {
    const wasProbing = this.probeInFlight
    this.probeInFlight = false
    this.consecutiveRefusals += 1

    // Already cooling down. Requests that were in flight when the circuit
    // tripped land here, and they must NOT each double the cool-down — six
    // concurrent 429s would otherwise turn a 60s pause into half an hour. Only
    // an explicit Retry-After that reaches further out extends it.
    if (this.currentState() === 'open') {
      if (retryAfterMs != null) {
        this.openedUntilMs = Math.max(
          this.openedUntilMs,
          this.now() + Math.min(this.maxCooldownMs, retryAfterMs)
        )
      }
      return
    }

    // A failed half-open probe re-opens immediately: we already had our answer.
    if (wasProbing || this.consecutiveRefusals >= this.threshold) {
      this.open(retryAfterMs)
    }
  }

  /**
   * The request never happened (the caller cancelled, or a deadline passed).
   * Hands back a consumed probe slot without counting for or against the host —
   * our own cancellation is not evidence about them.
   */
  recordAbandoned(): void {
    this.probeInFlight = false
  }

  private open(retryAfterMs: number | null): void {
    const backoff = this.baseCooldownMs * 2 ** Math.min(this.trips, 10)
    const cooldown = Math.min(this.maxCooldownMs, Math.max(backoff, retryAfterMs ?? 0))
    this.trips += 1
    this.state = 'open'
    this.openedUntilMs = this.now() + cooldown
  }
}

/** Statuses that mean "we are refusing you", as opposed to "no such thing". */
function isRefusalStatus(status: number): boolean {
  // 403 / 451: blocked outright. 429: too fast. 503: overloaded, or a WAF.
  return status === 403 || status === 429 || status === 451 || status === 503
}

/**
 * Refusals that specifically mean "you are going too fast", and so tighten the
 * per-host rate rather than merely counting toward the circuit.
 *
 * A bare 503 does NOT qualify: it is just as often one broken origin as it is
 * congestion, and halving our rate on every unrelated blip would leave a
 * perfectly healthy provider being crawled at a trickle. A 503 that carries a
 * Retry-After, though, is the server explicitly pacing us.
 */
function isPaceComplaint(status: number, retryAfterMs: number | null): boolean {
  return status === 429 || (status === 503 && retryAfterMs !== null)
}

// ---------------------------------------------------------------------------
// The per-host gate: breaker + concurrency + rate limit, one per hostname
// ---------------------------------------------------------------------------

// Set to smooth bursts, not to crawl. See the charter at the top: these hosts
// are CDN-backed public JSON APIs, and COMPANY_CONCURRENCY in the refresh route
// is 5, so in practice these limits only bind when many companies happen to
// share one provider — which is exactly the case they exist for.
const DEFAULT_RATE_PER_SEC = 10
const DEFAULT_BURST = 20
const MAX_CONCURRENT_PER_HOST = 6
/** Bound on the registry so a long-lived process cannot accumulate hosts forever. */
const MAX_TRACKED_HOSTS = 1024

interface Waiter {
  grant: () => void
  fail: (reason: unknown) => void
}

interface HostGate {
  host: string
  bucket: TokenBucket
  breaker: CircuitBreaker
  inFlight: number
  queue: Waiter[]
  lastUsedMs: number
}

const gates = new Map<string, HostGate>()

function gateFor(host: string): HostGate {
  const existing = gates.get(host)
  if (existing) {
    existing.lastUsedMs = Date.now()
    return existing
  }
  if (gates.size >= MAX_TRACKED_HOSTS) {
    // Evict the least-recently-used host that is not currently mid-request.
    // Dropping a gate only loses politeness *memory*, never correctness.
    let oldest: HostGate | null = null
    for (const gate of gates.values()) {
      if (gate.inFlight > 0 || gate.queue.length > 0) continue
      if (!oldest || gate.lastUsedMs < oldest.lastUsedMs) oldest = gate
    }
    if (oldest) gates.delete(oldest.host)
  }
  const created: HostGate = {
    host,
    bucket: new TokenBucket({ ratePerSec: DEFAULT_RATE_PER_SEC, burst: DEFAULT_BURST }),
    breaker: new CircuitBreaker(),
    inFlight: 0,
    queue: [],
    lastUsedMs: Date.now(),
  }
  gates.set(host, created)
  return created
}

function acquireSlot(gate: HostGate, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (gate.inFlight < MAX_CONCURRENT_PER_HOST) {
    gate.inFlight += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined
    const detach = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
    const waiter: Waiter = {
      grant: () => {
        detach()
        resolve()
      },
      fail: (reason) => {
        detach()
        reject(reason)
      },
    }
    if (signal) {
      onAbort = () => {
        const index = gate.queue.indexOf(waiter)
        if (index >= 0) gate.queue.splice(index, 1)
        waiter.fail(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    gate.queue.push(waiter)
  })
}

function releaseSlot(gate: HostGate): void {
  const next = gate.queue.shift()
  // Hand the slot straight to the next waiter rather than decrementing and
  // re-incrementing — otherwise a burst can slip past the limit in between.
  if (next) next.grant()
  else gate.inFlight = Math.max(0, gate.inFlight - 1)
}

/** What we currently believe about one host. Surfaced so a caller can explain
 *  "we stopped asking" to a user instead of silently returning nothing. */
export interface HostPolitenessState {
  host: string
  circuit: CircuitState
  /** Ms until the circuit is willing to admit a probe; 0 when it is not open. */
  cooldownRemainingMs: number
  /** Consecutive refusals since the last time this host answered normally. */
  refusalStreak: number
  /** Current allowance in requests/second (below the default after a 429). */
  ratePerSec: number
  inFlight: number
  queued: number
}

function snapshotOf(gate: HostGate): HostPolitenessState {
  return {
    host: gate.host,
    circuit: gate.breaker.currentState(),
    cooldownRemainingMs: gate.breaker.cooldownRemainingMs(),
    refusalStreak: gate.breaker.refusalStreak,
    ratePerSec: gate.bucket.ratePerSec,
    inFlight: gate.inFlight,
    queued: gate.queue.length,
  }
}

/** Politeness state for one host, or null if we have never called it. */
export function hostPolitenessState(host: string): HostPolitenessState | null {
  const gate = gates.get(host)
  return gate ? snapshotOf(gate) : null
}

/** Politeness state for every host this process has called. */
export function hostPolitenessSnapshot(): HostPolitenessState[] {
  return Array.from(gates.values(), snapshotOf)
}

/**
 * Forget every host's rate/circuit state and the conditional-request cache.
 *
 * This is a test seam. Do NOT call it between refresh runs in production: the
 * whole value of the breaker and the AIMD rate is that they REMEMBER what a
 * host told us last time, and a process that forgets on every run is a process
 * that re-learns "you are blocked" by getting blocked again.
 */
export function resetPolitenessState(): void {
  gates.clear()
  conditionalCache.clear()
  conditionalCacheBytes = 0
}

// ---------------------------------------------------------------------------
// Conditional requests (ETag / If-Modified-Since)
// ---------------------------------------------------------------------------

// The cheapest politeness there is: when a board has not changed since we last
// looked, the provider serves a 304 with no body and we skip the parse. For an
// hourly refresh over hundreds of companies, most fetches are unchanged.
//
// Bounded on purpose. This lives in module memory (per serverless instance, so
// it is a best-effort speedup and never a source of truth) and an unbounded map
// of board JSON would be a slow memory leak.
const CACHE_MAX_ENTRIES = 200
const CACHE_MAX_ENTRY_BYTES = 256 * 1024
const CACHE_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CacheEntry {
  etag: string | null
  lastModified: string | null
  body: string
  storedAtMs: number
}

const conditionalCache = new Map<string, CacheEntry>()
let conditionalCacheBytes = 0

/** Key on method + URL + Accept: the same URL fetched as JSON and as text can
 *  legitimately return different bodies, and a shared entry would serve one to
 *  the other. */
function cacheKey(url: string, method: string, accept: string): string {
  return `${method} ${accept} ${url}`
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = conditionalCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.storedAtMs > CACHE_MAX_AGE_MS) {
    conditionalCache.delete(key)
    conditionalCacheBytes -= entry.body.length
    return undefined
  }
  return entry
}

function cachePut(key: string, entry: CacheEntry): void {
  // No validator means no way to revalidate, so storing it would only ever cost
  // memory — we would have to re-download the body anyway.
  if (!entry.etag && !entry.lastModified) return
  if (entry.body.length > CACHE_MAX_ENTRY_BYTES) return

  const previous = conditionalCache.get(key)
  if (previous) conditionalCacheBytes -= previous.body.length
  conditionalCache.delete(key)
  conditionalCache.set(key, entry)
  conditionalCacheBytes += entry.body.length

  // Map iterates in insertion order, so the front is the least recently stored.
  while (
    conditionalCache.size > CACHE_MAX_ENTRIES ||
    conditionalCacheBytes > CACHE_MAX_TOTAL_BYTES
  ) {
    const oldestKey = conditionalCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = conditionalCache.get(oldestKey)
    conditionalCache.delete(oldestKey)
    if (oldest) conditionalCacheBytes -= oldest.body.length
  }
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

/** Combine two AbortSignals into one that aborts when either does. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (a.aborted || b.aborted) controller.abort()
  else {
    a.addEventListener('abort', onAbort, { once: true })
    b.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

/** A wait that a caller's cancel can cut short, honouring an injected sleep. */
async function politeWait(ms: number, opts: FetchJsonOptions): Promise<void> {
  if (ms <= 0) {
    opts.signal?.throwIfAborted()
    return
  }
  if (opts.sleep) {
    await opts.sleep(ms)
    opts.signal?.throwIfAborted()
    return
  }
  const signal = opts.signal
  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined
    const cleanup = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(signal.reason)
        return
      }
      onAbort = () => {
        clearTimeout(timer)
        cleanup()
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    // An unparseable URL is fetch's problem to report, not ours to gate.
    return ''
  }
}

/** Outcome of one request, as the per-host gate needs to see it. */
type Outcome =
  | { kind: 'answered'; status: number }
  | { kind: 'refused'; status: number; retryAfterMs: number | null }
  | { kind: 'unreachable' }

/**
 * One HTTP round trip: conditional headers in, body text out, and an outcome
 * reported to `onOutcome` for the per-host gate. Knows nothing about retries.
 */
async function requestOnce(
  url: string,
  opts: FetchJsonOptions,
  onOutcome: (outcome: Outcome) => void
): Promise<string> {
  const method = opts.method ?? 'GET'
  const accept = opts.headers?.accept ?? opts.headers?.Accept ?? 'application/json'
  // Only GET is revalidated: a cached body keyed by URL alone would be wrong
  // for POST the moment the request body changes (Workday pages this way).
  const useCache = method === 'GET' && opts.conditional !== false
  const key = cacheKey(url, method, accept)
  const cached = useCache ? cacheGet(key) : undefined

  const conditionalHeaders: Record<string, string> = {}
  if (cached?.etag) conditionalHeaders['if-none-match'] = cached.etag
  if (cached?.lastModified) conditionalHeaders['if-modified-since'] = cached.lastModified

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = combineSignals(opts.signal, controller.signal)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: {
          'user-agent': CELLO_USER_AGENT,
          accept: 'application/json',
          ...(opts.body != null ? { 'content-type': 'application/json' } : {}),
          ...conditionalHeaders,
          // Caller headers win: an adapter that sets its own Accept or its own
          // If-None-Match knows something we do not.
          ...(opts.headers ?? {}),
        },
        ...(opts.body != null ? { body: opts.body } : {}),
        // Never follow redirects: combined with per-adapter host allowlists this
        // guarantees the final host is one we vetted (no SSRF via redirect).
        // See FetchJsonOptions.redirect for why 'manual' is equally safe.
        redirect: opts.redirect ?? 'error',
        signal,
      })
    } catch (err) {
      // A refused connection, a DNS failure, a dropped socket. Not a refusal in
      // the "we've decided to block you" sense, but repeating it is just as
      // pointless, so the breaker counts it the same way.
      onOutcome({ kind: 'unreachable' })
      throw err
    }

    // 304: the provider confirmed our copy is still current. This is the whole
    // point of sending the validators — no body crosses the wire, and we do not
    // re-parse. It is also unambiguously a host that is happy to talk to us.
    if (res.status === 304 && cached) {
      onOutcome({ kind: 'answered', status: 304 })
      cachePut(key, {
        etag: res.headers.get('etag') ?? cached.etag,
        lastModified: res.headers.get('last-modified') ?? cached.lastModified,
        body: cached.body,
        storedAtMs: Date.now(),
      })
      return cached.body
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      onOutcome(
        isRefusalStatus(res.status)
          ? { kind: 'refused', status: res.status, retryAfterMs }
          : // A 404 for a board token that does not exist is a host answering
            // us perfectly politely. Counting it as a refusal would trip the
            // breaker on the most common non-200 in this codebase.
            { kind: 'answered', status: res.status }
      )
      throw new HttpError(
        `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${url}`,
        res.status,
        retryAfterMs
      )
    }

    onOutcome({ kind: 'answered', status: res.status })

    // res.text() is a UTF-8 decode by spec, and stays one even when a server
    // declares `charset=ISO-8859-1` in its Content-Type (verified) — so this
    // transport is NOT where mojibake ("9:00 AM â<U+0080><U+0093> 6:00 PM")
    // comes from, and there is no charset to honor here. Text that arrives
    // already mis-decoded was mis-decoded by the source; lib/jobs/mojibake.ts
    // repairs that at ingest. Please don't "fix" the decode here.
    const body = await res.text()

    if (useCache) {
      cachePut(key, {
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        body,
        storedAtMs: Date.now(),
      })
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/** Run one attempt behind the host's circuit breaker, concurrency cap and rate limit. */
async function guardedAttempt(url: string, opts: FetchJsonOptions): Promise<string> {
  const host = hostOf(url)
  if (!host) return requestOnce(url, opts, () => {})

  const gate = gateFor(host)
  if (!gate.breaker.allowRequest()) {
    throw new CircuitOpenError(host, gate.breaker.cooldownRemainingMs())
  }

  // Exactly one of success / refusal / abandoned must be reported, so a
  // half-open probe slot is never leaked by an early throw.
  let settled = false
  const report = (outcome: Outcome) => {
    if (settled) return
    settled = true
    if (outcome.kind === 'unreachable') {
      gate.breaker.recordRefusal(null)
      return
    }
    if (outcome.kind === 'refused') {
      gate.breaker.recordRefusal(outcome.retryAfterMs)
      if (isPaceComplaint(outcome.status, outcome.retryAfterMs)) gate.bucket.penalise()
      return
    }
    gate.breaker.recordSuccess()
    gate.bucket.reward()
  }

  try {
    await acquireSlot(gate, opts.signal)
  } catch (err) {
    if (!settled) {
      settled = true
      gate.breaker.recordAbandoned()
    }
    throw err
  }

  try {
    const waitMs = gate.bucket.reserve()
    if (waitMs > 0) await politeWait(waitMs, opts)
    return await requestOnce(url, opts, report)
  } finally {
    releaseSlot(gate)
    if (!settled) {
      settled = true
      gate.breaker.recordAbandoned()
    }
  }
}

function withRetry<T>(url: string, opts: FetchJsonOptions, read: (body: string) => T): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 3)
  return pRetry(async () => read(await guardedAttempt(url, opts)), {
    retries,
    // p-retry drives the LOOP; this module owns the DELAY. minTimeout 0 makes
    // p-retry's own wait a no-op so the only wait is the one computed in
    // onFailedAttempt — which is what lets a server-stated Retry-After REPLACE
    // the schedule rather than be added to it, and what makes the jitter shape
    // (backoffDelayMs) something we can unit test.
    minTimeout: 0,
    maxTimeout: 0,
    // The retry LOOP's stop signal is the caller's own cancel/deadline only
    // — NOT the per-attempt timeout controller requestOnce builds internally.
    // A single slow attempt timing out is exactly the transient case worth
    // retrying; only an explicit caller cancel should stop the whole loop.
    signal: opts.signal,
    shouldRetry: ({ error }) => isTransient(error),
    onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
      // onFailedAttempt runs BEFORE shouldRetry and even on the final failure,
      // so both guards are load-bearing: without them a 402 would sit through a
      // backoff on its way to failing immediately.
      if (retriesLeft <= 0) return
      if (!isTransient(error)) return

      const retryAfterMs = retryAfterMsOf(error)
      if (retryAfterMs !== null && retryAfterMs > MAX_INLINE_RETRY_WAIT_MS) {
        // The host named a wait longer than we will hold a request open for.
        // Throwing here aborts the retry loop and rejects with the original
        // error; the refusal is already recorded against the host's circuit, so
        // the cool-down — not a sleeping request — is what honours the delay.
        throw error
      }

      await politeWait(
        backoffDelayMs({
          attempt: attemptNumber,
          baseMs: opts.backoffBaseMs,
          capMs: opts.backoffCapMs,
          retryAfterMs,
        }),
        opts
      )
    },
  })
}

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  return withRetry(url, opts, (body) => JSON.parse(body) as T)
}

/**
 * Same transport (host allowlist, timeout, retry policy, no redirects, per-host
 * politeness) for a body that isn't JSON. Personio's public board is XML, not
 * JSON — see ./personio.ts — and routing it through here rather than a bare
 * fetch is what keeps every ATS request under one set of SSRF/timeout/retry and
 * rate-limit rules.
 */
export async function fetchText(url: string, opts: FetchJsonOptions = {}): Promise<string> {
  return withRetry(
    url,
    { ...opts, headers: { accept: 'text/xml, application/xml, text/plain, */*', ...(opts.headers ?? {}) } },
    (body) => body
  )
}

// ---------------------------------------------------------------------------
// SSRF host guards
// ---------------------------------------------------------------------------

function assertHttps(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`ats: invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`ats: URL must use HTTPS: ${url}`)
  }
  return parsed
}

/** Throw unless the URL is https and its host is in the allowlist. */
export function assertAllowedHost(url: string, allowedHosts: ReadonlySet<string>): string {
  const parsed = assertHttps(url)
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`ats: untrusted hostname "${parsed.hostname}"`)
  }
  return url
}

/**
 * Same guarantee as assertAllowedHost for the providers that give every
 * customer their own subdomain — Recruitee ({co}.recruitee.com), Personio
 * ({co}.jobs.personio.de), Workday ({tenant}.wd{N}.myworkdayjobs.com) — where
 * a fixed host set cannot be written down ahead of time.
 *
 * Each suffix must start with a dot, so this can only ever widen the allowlist
 * *within* a vendor's domain: "evilrecruitee.com" does not end with
 * ".recruitee.com" and is rejected, and neither is a bare "recruitee.com"
 * accepted. The board token itself is separately constrained to TOKEN_RE
 * (no "/", "@", ":", "?" or "#"), so it cannot smuggle a different authority
 * into the URL before this check runs.
 */
export function assertAllowedHostSuffix(url: string, allowedSuffixes: readonly string[]): string {
  const parsed = assertHttps(url)
  const host = parsed.hostname
  const ok = allowedSuffixes.some((suffix) => suffix.startsWith('.') && host.endsWith(suffix) && host.length > suffix.length)
  if (!ok) {
    throw new Error(`ats: untrusted hostname "${host}"`)
  }
  return url
}
