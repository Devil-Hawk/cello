// lib/search/index.ts — Cello's own web_search TOOL. Provider-agnostic:
// works identically whether the user is on OpenRouter, a local model, or a
// signed-in Claude/Codex subscription CLI, because it is not a per-provider
// model capability at all (NOT OpenRouter's :online plugin) — it's a plain
// HTTP tool the harness calls itself, exactly like Claude Code / opencode own
// their own web_search. See docs/PRODUCT-VISION.md ("Sourcing"): the 3 ATS
// adapters + 11 keyless aggregators only cover boards Cello already knows
// about, so "find me 10 AI Engineer roles" can fail even when real openings
// exist elsewhere on the open web.
//
// THE PRODUCTION PROBLEM THIS FILE SOLVES: the free, keyless DuckDuckGo HTML
// scrape (backends/duckduckgo.ts) is bot-challenged from a datacenter/VPS
// egress IP on the very first request — a real, correctly-detected failure
// (reason:'blocked'), not a bug in that backend. Returning that failure
// straight to the caller is HONEST but means open-web discovery simply
// doesn't work from where Cello actually runs in production. So webSearch()
// is a FAILOVER CHAIN, not a single backend pick: it tries every backend the
// user has configured, in priority order, and only reports failure once
// EVERY candidate has failed — see CHAIN_ORDER below.
//
// CHAIN_ORDER (cheapest/most-reliable-free-tier first, keyless last resort):
//   1. tavily  — BYOK, 1,000 free searches/month, RECURRING, no card. Best
//                free default for a deployed Cello.
//   2. serper  — BYOK, 2,500 free queries ONE TIME, then cheap ($0.30-1/1k).
//   3. exa     — BYOK, ~$10/mo free credits then ~$7/1k. Priciest of the
//                three, tried last among the paid options.
//   4. searxng — a self-hosted instance (or one configured deployment-wide
//                via SEARXNG_BASE_URL — see keys.ts's getSearxngBaseUrl) —
//                zero marginal cost but depends on infra the user runs.
//   5. duckduckgo — free, keyless, always "configured" — the true last
//                resort, since it's the one most likely to be blocked from a
//                server IP.
// A backend that just failed is deprioritized (not permanently excluded) via
// lib/search/health.ts's short-TTL memory, so a call doesn't repeatedly waste
// a round trip on a backend that's currently down — see runChain() below.
//
// tavily/serper/searxng are loaded lazily through loadOptionalBackendFn()'s
// STATIC LITERAL import() map (see that function's comment for why the
// specifiers must be literals) — each stays its own chunk, fetched only if
// the chain actually reaches it, and the chain still degrades to "skip this
// candidate" if one fails to load at runtime.
// exa and duckduckgo are imported normally — both are this module's own
// long-standing, stable dependencies.
//
// NEVER THROWS: every failure path (empty query, every backend blocked/out
// of quota/erroring, a network error) returns a structured
// {ok:false, reason, detail, results:[]} instead of throwing — per
// docs/PRODUCT-VISION.md's reliability bar, "no tool call, no web search ...
// ever hard-crashes the request" — and on total failure, `detail` names every
// backend tried and why each failed, with an actionable next step, so a
// caller (a copilot tool, the Settings page) can tell the user something
// useful instead of a bare "search failed".

import { classifyError } from '../util/retry'
import { searchDuckDuckGo, DuckDuckGoBlockedError } from './backends/duckduckgo'
import { searchExa } from './backends/exa'
import { getSearchProviderKeys, getSearxngBaseUrl } from './keys'
import { recordBackendFailure, recordBackendSuccess, isBackendRecentlyFailed } from './health'
import { SearchBlockedError, SearchQuotaExceededError } from './types'
import type {
  SearchAttempt,
  SearchBackendId,
  SearchFailureReason,
  SearchResult,
  WebSearchOptions,
  WebSearchResponse,
} from './types'

export type {
  SearchAttempt,
  SearchBackendId,
  SearchFailureReason,
  SearchResult,
  WebSearchOptions,
  WebSearchResponse,
} from './types'
export { DuckDuckGoBlockedError } from './backends/duckduckgo'
export { SearchBlockedError, SearchQuotaExceededError } from './types'

const FRESHNESS_DAYS: Record<NonNullable<WebSearchOptions['freshness']>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
}

/** Exa wants an absolute `startPublishedDate`; every other backend takes the
 *  relative `freshness` token directly. */
function startPublishedDateFor(freshness: WebSearchOptions['freshness']): string | undefined {
  if (!freshness) return undefined
  const days = FRESHNESS_DAYS[freshness]
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

const BACKEND_LABEL: Record<SearchBackendId, string> = {
  tavily: 'Tavily',
  serper: 'Serper',
  exa: 'Exa',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
}

function failure(
  backend: SearchBackendId,
  reason: NonNullable<WebSearchResponse['reason']>,
  detail?: string
): WebSearchResponse {
  return { backend, results: [], ok: false, reason, detail }
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

interface ResolvedCredentials {
  exa?: string
  tavily?: string
  serper?: string
  /** SearXNG base URL — not a secret the way an API key is, but resolved the
   *  same way (direct opts value wins, else DB-per-user, else keys.ts's own
   *  SEARXNG_BASE_URL env var fallback for a single-tenant self-host). */
  searxng?: string
}

/**
 * Resolve every BYOK credential the chain might use: an already-provided
 * opts.*Key/opts.searxngUrl wins outright (no DB call for that field);
 * anything still missing, given opts.userId, is resolved via lib/search/
 * keys.ts through the service-role admin client — one combined query for
 * exa/tavily/serper (getSearchProviderKeys) plus one for searxng (its env-var
 * fallback lives only in getSearxngBaseUrl, so it stays a separate call
 * rather than duplicating that logic here). Every failure (no userId either,
 * missing service-role env, a DB error, nothing configured) degrades every
 * still-missing field to `undefined` rather than throwing — the chain simply
 * treats that backend as not configured, exactly as if userId was never
 * passed at all.
 */
async function resolveCredentials(opts: WebSearchOptions): Promise<ResolvedCredentials> {
  const out: ResolvedCredentials = {
    exa: opts.exaKey,
    tavily: opts.tavilyKey,
    serper: opts.serperKey,
    searxng: opts.searxngUrl,
  }
  if (!opts.userId) return out

  try {
    const { createAdminClient } = await import('@/lib/harness/supabase-admin')
    const admin = createAdminClient()

    if (out.exa === undefined || out.tavily === undefined || out.serper === undefined) {
      const resolved = await getSearchProviderKeys(admin, opts.userId)
      out.exa = out.exa ?? resolved.exa
      out.tavily = out.tavily ?? resolved.tavily
      out.serper = out.serper ?? resolved.serper
    }
    if (out.searxng === undefined) {
      out.searxng = await getSearxngBaseUrl(admin, opts.userId)
    }
  } catch {
    // degrade silently — see doc comment above.
  }
  return out
}

// ---------------------------------------------------------------------------
// Optional-backend loading (tavily / serper / searxng)
// ---------------------------------------------------------------------------

interface BackendCallOpts {
  limit?: number
  freshness?: WebSearchOptions['freshness']
  startPublishedDate?: string
  timeoutMs?: number
  signal?: AbortSignal
}

type OptionalBackendFn = (query: string, credential: string, opts: BackendCallOpts) => Promise<SearchResult[]>

/** The optional backends this build can load, each behind a LAZY but
 *  STATICALLY ANALYZABLE import.
 *
 *  These specifiers are string literals on purpose. An earlier version took
 *  the module path as a function parameter, reasoning that a non-literal
 *  specifier is invisible to tsc/webpack and therefore could never fail the
 *  build while backends/*.ts were still being written. That reasoning was
 *  correct about the BUILD and wrong about PRODUCTION: webpack only bundles a
 *  dynamic import whose specifier it can resolve statically. Given an opaque
 *  one it emits "Critical dependency: the request of a dependency is an
 *  expression" and bundles NOTHING, so at runtime the import throws, the
 *  catch below swallows it, and all three backends report as "code not
 *  present" — a message that reads as "add a key" when the truth is "this
 *  code was never shipped".
 *
 *  Measured against the compiled output, not assumed: `api.tavily.com` and
 *  `google.serper.dev` appeared in 0 files under .next/server, while the
 *  statically-imported `html.duckduckgo.com` and `api.exa.ai` were both
 *  present. Unit tests missed it because vitest resolves the relative TS path
 *  natively through Node/Vite — they exercised a code path that a webpack
 *  bundle cannot have. Same failure class as the prompts/*.md file-tracing
 *  note at the top of next.config.js: works in dev, absent in prod.
 *
 *  A literal map keeps the property that actually mattered — each backend is
 *  still a separate chunk, only loaded if the chain reaches it — while being
 *  statically analyzable. The build-safety property is genuinely traded away:
 *  deleting or renaming a backend file now fails `tsc` instead of silently
 *  degrading. That is the better failure: loud at build time rather than
 *  invisible in production. */
export type OptionalBackendId = 'tavily' | 'serper' | 'searxng'

const OPTIONAL_BACKEND_MODULES: Record<OptionalBackendId, () => Promise<unknown>> = {
  tavily: () => import('./backends/tavily'),
  serper: () => import('./backends/serper'),
  searxng: () => import('./backends/searxng'),
}

const OPTIONAL_BACKEND_EXPORT: Record<OptionalBackendId, string> = {
  tavily: 'searchTavily',
  serper: 'searchSerper',
  searxng: 'searchSearxng',
}

/**
 * Load one optional backend's search function by backend id. A module that
 * fails to load, or that lacks the expected export, resolves to `null` — the
 * caller (buildCandidates below) turns that into an ordinary request_failed
 * attempt for that one backend, never a crash.
 *
 * Exported so the Settings status endpoint can reuse this exact probe to
 * report, honestly, whether a backend's code is present in THIS build.
 */
export async function loadOptionalBackendFn(id: OptionalBackendId): Promise<OptionalBackendFn | null> {
  try {
    const mod = (await OPTIONAL_BACKEND_MODULES[id]()) as Record<string, unknown> | undefined
    const fn = mod?.[OPTIONAL_BACKEND_EXPORT[id]]
    return typeof fn === 'function' ? (fn as OptionalBackendFn) : null
  } catch {
    return null
  }
}

interface OptionalBackendDescriptor {
  id: OptionalBackendId
}

/** The contract each backends/*.ts module satisfies:
 *  `export async function search<Name>(query: string, credential: string,
 *  opts: {limit?, freshness?, timeoutMs?, signal?}): Promise<SearchResult[]>`
 *  — the exact shape searchExa/searchDuckDuckGo already established. */
const OPTIONAL_BACKENDS: OptionalBackendDescriptor[] = [
  { id: 'tavily' },
  { id: 'serper' },
  { id: 'searxng' },
]

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** HTTP statuses a backend can throw (via lib/search/fetch.ts's
 *  SearchHttpError, which carries `.status`) that mean something more
 *  specific than the generic transient/permanent split — 402/432/433 are the
 *  quota-exhaustion codes Tavily's own docs enumerate (see backends/
 *  tavily.ts); 429 is the universal rate-limit status every backend here
 *  uses. */
const HTTP_STATUS_REASON: Partial<Record<number, SearchFailureReason>> = {
  402: 'quota',
  429: 'rate_limited',
  432: 'quota',
  433: 'quota',
}

/**
 * Turn a caught error from any backend's search function into a
 * (reason, detail) pair. Recognizes the two shared error classes
 * (SearchBlockedError / SearchQuotaExceededError, and DuckDuckGoBlockedError
 * by its own long-standing name) explicitly; falls back to the caught
 * error's HTTP status (HTTP_STATUS_REASON above), then to a defensive
 * name/message substring match for "blocked"/"quota" (so a backend module
 * that signals either WITHOUT importing this app's error classes — just by
 * naming its own error sensibly — still gets classified correctly); and
 * finally to the shared transient/permanent classifier
 * (lib/util/retry.ts's classifyError) for everything else.
 */
export function classifyBackendFailure(error: unknown): { reason: SearchFailureReason; detail: string } {
  const detail = error instanceof Error ? error.message : String(error)

  if (error instanceof DuckDuckGoBlockedError || error instanceof SearchBlockedError) {
    return { reason: 'blocked', detail }
  }
  if (error instanceof SearchQuotaExceededError) {
    return { reason: 'quota', detail }
  }

  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined
  if (status !== undefined && HTTP_STATUS_REASON[status]) {
    return { reason: HTTP_STATUS_REASON[status] as SearchFailureReason, detail }
  }

  const name = error instanceof Error ? error.name : ''
  const haystack = `${name} ${detail}`.toLowerCase()
  if (haystack.includes('blocked') || haystack.includes('captcha') || haystack.includes('challenge')) {
    return { reason: 'blocked', detail }
  }
  if (haystack.includes('quota') || haystack.includes('credit') || haystack.includes('usage limit')) {
    return { reason: 'quota', detail }
  }

  return { reason: classifyError(error) === 'transient' ? 'rate_limited' : 'request_failed', detail }
}

// ---------------------------------------------------------------------------
// Candidate chain
// ---------------------------------------------------------------------------

interface BackendCandidate {
  id: SearchBackendId
  configured: boolean
  run: () => Promise<SearchResult[]>
}

/** Build the fixed, priority-ordered candidate list (see CHAIN_ORDER in the
 *  module header) — `configured` reflects whether a credential is present
 *  for that backend; `duckduckgo` is always configured (keyless). Building
 *  this never itself performs I/O — the network/DB work is deferred to each
 *  candidate's own `run()`. */
function buildCandidates(query: string, creds: ResolvedCredentials, callOpts: BackendCallOpts): BackendCandidate[] {
  const optional = (descriptor: OptionalBackendDescriptor, credential: string | undefined): BackendCandidate => ({
    id: descriptor.id,
    configured: Boolean(credential),
    run: async () => {
      const fn = await loadOptionalBackendFn(descriptor.id)
      if (!fn) throw new Error(`${BACKEND_LABEL[descriptor.id]} backend module is not available`)
      return fn(query, credential as string, callOpts)
    },
  })

  return [
    optional(OPTIONAL_BACKENDS[0], creds.tavily),
    optional(OPTIONAL_BACKENDS[1], creds.serper),
    {
      id: 'exa',
      configured: Boolean(creds.exa),
      run: () => searchExa(query, creds.exa as string, callOpts),
    },
    optional(OPTIONAL_BACKENDS[2], creds.searxng),
    {
      id: 'duckduckgo',
      configured: true,
      run: () => searchDuckDuckGo(query, callOpts),
    },
  ]
}

/** Human-readable summary for an all-failed WebSearchResponse's `detail` —
 *  names every candidate and why it didn't work, in priority order, plus one
 *  actionable next step. Exported for the Settings page / tests to reuse the
 *  exact same wording the tool itself returns. */
export function describeAttempts(attempts: SearchAttempt[]): string {
  const parts = attempts.map((a) => {
    if (a.reason === 'no_key') return `${BACKEND_LABEL[a.backend]} (not configured)`
    return `${BACKEND_LABEL[a.backend]} (${a.reason}${a.detail ? `: ${a.detail}` : ''})`
  })
  const anyByokConfigured = attempts.some((a) => a.backend !== 'duckduckgo' && a.reason !== 'no_key')
  const suggestion = anyByokConfigured
    ? 'Every configured search backend failed this time — try again shortly, or check Settings → Search.'
    : 'No search backend is configured — DuckDuckGo (free) is frequently blocked from server/datacenter IPs. Add a Tavily or Serper key in Settings → Search for reliable results.'
  return `Tried ${parts.join('; ')}. ${suggestion}`
}

/**
 * Walk `candidates` in priority order, skipping (deprioritizing) any that
 * failed recently (lib/search/health.ts) in favor of one that hasn't, but —
 * critically — still falling back to a recently-failed one as a genuine last
 * resort if nothing healthier works, so "only when every candidate fails
 * does webSearch() return ok:false" stays true even when health memory has
 * every configured backend marked down. A recently-failed backend that
 * actually succeeds when finally tried self-heals immediately
 * (recordBackendSuccess), not just after its TTL.
 */
async function runChain(candidates: BackendCandidate[]): Promise<WebSearchResponse> {
  const realAttempts = new Map<SearchBackendId, SearchAttempt>()
  const configured = candidates.filter((c) => c.configured)
  const healthyNow = configured.filter((c) => !isBackendRecentlyFailed(c.id))
  const recentlyFailed = configured.filter((c) => isBackendRecentlyFailed(c.id))

  for (const pass of [healthyNow, recentlyFailed]) {
    for (const cand of pass) {
      try {
        const results = await cand.run()
        recordBackendSuccess(cand.id)
        const successAttempt: SearchAttempt = {
          backend: cand.id,
          ok: true,
          reason: results.length === 0 ? 'no_results' : undefined,
        }
        realAttempts.set(cand.id, successAttempt)
        // Only attach `attempts` when this call actually fell through a real
        // prior failure — a first-try success (the overwhelmingly common
        // case) stays lean.
        const orderedReal = candidates.map((c) => realAttempts.get(c.id)).filter((a): a is SearchAttempt => Boolean(a))
        return {
          backend: cand.id,
          results,
          ok: true,
          reason: successAttempt.reason,
          ...(orderedReal.length > 1 ? { attempts: orderedReal } : {}),
        }
      } catch (error) {
        const { reason, detail } = classifyBackendFailure(error)
        recordBackendFailure(cand.id, reason, detail)
        realAttempts.set(cand.id, { backend: cand.id, ok: false, reason, detail })
      }
    }
  }

  // Every candidate exhausted (attempted-and-failed, or never configured) —
  // build the complete, priority-ordered picture for an honest, actionable
  // failure response.
  const fullAttempts: SearchAttempt[] = candidates.map(
    (c) => realAttempts.get(c.id) ?? { backend: c.id, ok: false, reason: 'no_key', detail: 'not configured' }
  )
  const last = fullAttempts[fullAttempts.length - 1]
  return {
    backend: last.backend,
    results: [],
    ok: false,
    reason: 'all_failed',
    detail: describeAttempts(fullAttempts),
    attempts: fullAttempts,
  }
}

/**
 * Run one web search. With no `opts.backend` override, tries every
 * configured backend in priority order (see the module header's
 * CHAIN_ORDER) and returns the first success; only when every candidate
 * fails does this return ok:false, with `detail`/`attempts` naming what was
 * tried and why each failed. `opts.backend` bypasses the chain entirely and
 * targets exactly one backend — mainly for tests and a Settings "test this
 * backend" diagnostic.
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const trimmed = (query ?? '').trim()
  // Bail before any credential resolution (which may be a DB round trip) —
  // an empty query never needs one.
  if (!trimmed) return failure(opts.backend ?? 'duckduckgo', 'empty_query', 'query was empty')

  const callOpts: BackendCallOpts = {
    limit: opts.limit,
    freshness: opts.freshness,
    startPublishedDate: startPublishedDateFor(opts.freshness),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  }

  const creds = await resolveCredentials(opts)
  const candidates = buildCandidates(trimmed, creds, callOpts)

  if (opts.backend) {
    const forced = candidates.find((c) => c.id === opts.backend)
    if (!forced) return failure(opts.backend, 'request_failed', `Unknown backend "${opts.backend}"`)
    if (!forced.configured) {
      return failure(
        opts.backend,
        'no_key',
        `${BACKEND_LABEL[opts.backend]} backend selected but no credential was provided/resolved`
      )
    }
    try {
      const results = await forced.run()
      recordBackendSuccess(forced.id)
      return { backend: forced.id, results, ok: true, reason: results.length === 0 ? 'no_results' : undefined }
    } catch (error) {
      const { reason, detail } = classifyBackendFailure(error)
      recordBackendFailure(forced.id, reason, detail)
      return failure(forced.id, reason, detail)
    }
  }

  return runChain(candidates)
}
