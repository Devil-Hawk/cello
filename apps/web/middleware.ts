// The session boundary.
//
// ---------------------------------------------------------------------------
// WHY A DEMO EXPIRY CHECK LIVES HERE AND NOT ONLY IN THE KEY LOADERS
// ---------------------------------------------------------------------------
// lib/harness/keys.ts and lib/apikeys.ts already refuse an expired demo, and
// that covers every path to a PAID MODEL. It covers nothing else. Browsing the
// seeded jobs list, opening a company, saving a note, GET /api/digest — none of
// those asks anyone for an API key, so none of them passed through a
// chokepoint, and an hour-73 session kept working exactly as it had at hour 71.
// The product promise is "72 hours of access", not "72 hours of AI", so the
// deadline has to be enforced where ACCESS is decided: before the request is
// served at all, for pages and for API routes alike.
//
// Middleware is the only place in this app that sees both. It already runs on
// every request (it is where the Supabase session is refreshed), so the check
// is added to a hop that was happening anyway rather than creating a new one.
//
// ---------------------------------------------------------------------------
// WHY THE POLICY IS RESTATED HERE INSTEAD OF IMPORTED
// ---------------------------------------------------------------------------
// demoSessionGate() in lib/access/guardrails.ts is the canonical version of the
// six lines below, and importing it would be the obvious thing to do. It cannot
// be imported: guardrails.ts pulls in lib/access/codes.ts for
// describeTimeRemaining, codes.ts imports `node:crypto` at module scope, and
// Next 14 bundles middleware for the EDGE runtime, which refuses a Node builtin
// at build time ("A Node.js module is loaded ('node:crypto') which is not
// supported in the Edge Runtime"). Middleware in Next 14 has no `runtime =
// 'nodejs'` escape hatch.
//
// A second copy of a security rule is a liability, so it is pinned rather than
// merely written: demoWindowGate is exported and
// lib/access/demo-chokepoints.test.ts runs the SAME truth table through it and
// through demoSessionGate and requires identical answers, case by case,
// including the boundary instant and every fail-closed branch. If the canonical
// policy changes and this one does not, that test fails.
//
// ---------------------------------------------------------------------------
// EVERYTHING HERE FAILS CLOSED
// ---------------------------------------------------------------------------
// A missing profile row, a demo with no deadline, a deadline that will not
// parse: all refuse. `new Date('nope').getTime()` is NaN and every comparison
// against NaN is false, so the naive check reads corruption as "not expired
// yet" and hands out a session that lives forever — which is precisely how
// lib/outreach/guardrails.ts's follow-up window failed open once already.
//
// The ONE documented exception is a database whose schema predates the
// access-codes migration; see NO_DEMO_COLUMNS below for why allowing there is a
// proof rather than a guess.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { updateSession } from '@/lib/supabase/middleware'

const publicRoutes = ['/login', '/auth/callback']

/**
 * Paths a SIGNED-IN session may reach even when its demo window has closed.
 *
 * Only redemption. Someone whose code has lapsed is holding a dead session and
 * a browser pointed at this app; the one useful thing they can do is type a
 * fresh code, and POST /api/access/redeem is what turns that into a new
 * session. Blocking it would mean the only way out of an expired demo is to
 * clear cookies by hand. It grants nothing: the route authenticates the CODE,
 * never the caller's cookie, and it is rate limited independently.
 *
 * Public routes (/login, /auth/callback) are exempt separately, below.
 */
const EXPIRED_SESSION_ESCAPE_HATCHES = ['/api/access/redeem']

// --- The policy (mirror of lib/access/guardrails.ts demoSessionGate) ---------

/** The two profile columns that decide whether a session may still act. */
export interface DemoWindowFacts {
  is_demo: boolean | null
  demo_expires_at: string | null
}

/**
 * Refusal codes, spelled exactly as lib/access/guardrails.ts spells them, so
 * the equivalence test can compare the two implementations field by field
 * rather than by a loose "both said no".
 */
export type DemoWindowRefusal =
  | 'profile-unavailable'
  | 'demo-expired'
  | 'demo-expiry-missing'
  | 'demo-expiry-unreadable'

export interface DemoWindowGate {
  allowed: boolean
  code?: DemoWindowRefusal
}

/**
 * May this session still be served at all?
 *
 * `facts` is null when the profile could not be established — an unreadable
 * row, a row that is not there, a client that could not be built. That refuses,
 * because absence of proof is not proof of absence and the cost of blocking a
 * real user for one request is a retry.
 *
 * A profile counts as a demo if EITHER signal says so, matching isDemoProfile:
 * a row carrying a demo deadline is a demo even if the flag was dropped by a
 * partial update, and treating that as an ordinary account would hand it a
 * never-expiring session.
 *
 * Exported ONLY so the equivalence test can execute it. Nothing imports it at
 * runtime; Next's middleware entrypoint reads `middleware` and `config`, and
 * ignores every other export.
 */
export function demoWindowGate(facts: DemoWindowFacts | null, now: Date = new Date()): DemoWindowGate {
  if (!facts) return { allowed: false, code: 'profile-unavailable' }

  const isDemo = facts.is_demo === true || Boolean(facts.demo_expires_at)
  if (!isDemo) return { allowed: true }

  // A demo with no deadline is the "lives forever" bug in its exact shape, so
  // it can never be the state that grants access.
  if (!facts.demo_expires_at) return { allowed: false, code: 'demo-expiry-missing' }

  const expiresMs = new Date(facts.demo_expires_at).getTime()
  if (!Number.isFinite(expiresMs)) return { allowed: false, code: 'demo-expiry-unreadable' }

  // `>=` not `>`: the deadline is the first instant the session is dead, which
  // is how accessCodeUsability and demoSessionGate both read the same boundary.
  if (now.getTime() >= expiresMs) return { allowed: false, code: 'demo-expired' }

  return { allowed: true }
}

// --- Reading the facts, and what that costs ----------------------------------

/**
 * A resolved read.
 *
 * NO_DEMO_COLUMNS is the one state that allows without proving the session is
 * live, and it is a proof rather than a guess: `is_demo` and `demo_expires_at`
 * are added by the same migration that creates access_codes, and
 * app/api/access/redeem/route.ts writes both when it mints a workspace. A
 * schema without those columns therefore cannot contain a demo profile and
 * cannot have redeemed a code — there is nothing to enforce. Without this
 * branch, deploying this file before applying 20260803000002 would refuse every
 * request from every user, owner included, which is a far larger outage than
 * the thing being guarded against.
 */
type DemoWindowRead = { kind: 'facts'; facts: DemoWindowFacts } | { kind: 'none' } | { kind: 'unreadable' }

/** PostgREST surfaces a missing column as Postgres 42703 (undefined_column). */
const UNDEFINED_COLUMN = '42703'

/**
 * How long a resolved read is reused, in ms.
 *
 * THIS TTL CANNOT DELAY EXPIRY. What is cached is the DEADLINE, not the
 * verdict — demoWindowGate re-runs against `new Date()` on every single
 * request, so an hour-72 session is refused the instant it arrives, cache or no
 * cache. What the TTL does bound is staleness in the OTHER two facts:
 *
 *   * a profile that becomes a demo after being cached as an ordinary account.
 *     Not a state this feature produces — demo workspaces are minted fresh at
 *     redemption, never converted from an existing account — but bounded at 60s
 *     rather than unbounded, because "not a state today" is not a guarantee.
 *   * a deadline moved EARLIER. Revoking a code today sets
 *     access_codes.revoked_at and does not touch the profile at all, so
 *     revocation is not enforced here with or without this cache. See the
 *     report accompanying this change; the fix belongs in the revoke route.
 */
const DEMO_FACTS_TTL_MS = 60_000

/**
 * Cache ceiling. Entries are two nullable scalars keyed by user id — nothing
 * secret, nothing per-request — and the map lives in the middleware isolate,
 * so this is a memory bound, not a correctness one. Oldest-first eviction
 * because Map preserves insertion order.
 */
const DEMO_FACTS_MAX_ENTRIES = 5000

interface CacheEntry {
  read: DemoWindowRead
  readAtMs: number
}

const demoFactsCache = new Map<string, CacheEntry>()

function cacheGet(userId: string, nowMs: number): DemoWindowRead | null {
  const hit = demoFactsCache.get(userId)
  if (!hit) return null
  if (nowMs - hit.readAtMs >= DEMO_FACTS_TTL_MS) {
    demoFactsCache.delete(userId)
    return null
  }
  return hit.read
}

function cacheSet(userId: string, read: DemoWindowRead, nowMs: number): void {
  // Never cache a failure. An unreadable profile is a transient condition and
  // caching it would turn one blip into a minute of refusals; it is also the
  // fail-closed branch, so retrying costs the user nothing but a reload.
  if (read.kind === 'unreadable') return

  if (demoFactsCache.size >= DEMO_FACTS_MAX_ENTRIES) {
    const oldest = demoFactsCache.keys().next()
    if (!oldest.done) demoFactsCache.delete(oldest.value)
  }
  demoFactsCache.set(userId, { read, readAtMs: nowMs })
}

/** Logged once per isolate, not once per request — this is a deploy-order bug. */
let warnedAboutMissingColumns = false

/**
 * Read is_demo / demo_expires_at for the signed-in user.
 *
 * WHY THE CALLER'S OWN CLIENT AND NOT THE SERVICE KEY. lib/access/session.ts
 * deliberately uses the service key for the same two columns, because the
 * subject of an AUDIT TRAIL must not get a vote on whether it is recorded. This
 * is a different question. Here the session cannot benefit from interfering:
 * profiles' RLS lets a user SELECT only their own row, migration
 * 20260803000003's trigger stops a demo from writing either column, and any
 * read that fails or returns nothing lands on the refusal branch. So the worst
 * a demo can do to this read is lock itself out. The service key, meanwhile,
 * must never enter an Edge bundle, which is what middleware is.
 *
 * Never throws.
 */
async function readDemoWindowFacts(request: NextRequest, userId: string): Promise<DemoWindowRead> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return { kind: 'unreadable' }

  try {
    // Read-only cookie adapter on purpose: updateSession() has already
    // refreshed the session and written the new tokens onto request.cookies, so
    // this client sees current tokens, and giving it a `setAll` would let two
    // clients race to write the same Set-Cookie header on one response.
    const client = createServerClient(url, anonKey, {
      cookies: { getAll: () => request.cookies.getAll() },
      // is_demo / demo_expires_at are not in @cello/shared's generated Database
      // type yet, so the read goes through an untyped view of the client — the
      // same escape hatch lib/apikeys.ts uses for the identical reason.
    }) as unknown as SupabaseClient

    const { data, error } = await client
      .from('profiles')
      .select('is_demo, demo_expires_at')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      if (error.code === UNDEFINED_COLUMN) {
        if (!warnedAboutMissingColumns) {
          warnedAboutMissingColumns = true
          console.error(
            '[middleware] profiles.is_demo / demo_expires_at do not exist — apply ' +
              'supabase/migrations/20260803000002_access_codes.sql. Demo expiry is NOT being ' +
              'enforced at the session boundary until it is.'
          )
        }
        return { kind: 'none' }
      }
      console.error(`[middleware] demo window read failed for ${userId} — ${error.message}`)
      return { kind: 'unreadable' }
    }

    // maybeSingle() returns null rather than erroring when no row matched. A
    // missing profile is not evidence of an ordinary account, so it refuses.
    if (!data) return { kind: 'unreadable' }

    const row = data as { is_demo?: boolean | null; demo_expires_at?: string | null }
    return {
      kind: 'facts',
      facts: { is_demo: row.is_demo ?? null, demo_expires_at: row.demo_expires_at ?? null },
    }
  } catch (err) {
    console.error(`[middleware] demo window read threw for ${userId}`, err)
    return { kind: 'unreadable' }
  }
}

/**
 * The whole check: cached read, then the gate.
 *
 * COST. Every signed-in request already spends one round trip on
 * supabase.auth.getUser() inside updateSession(). This adds at most one more —
 * a primary-key SELECT of two columns from profiles, against the same project,
 * from the same region — and the cache means it is paid once per user per
 * minute rather than once per request, so a session clicking through the app
 * amortises it to nearly nothing. The worst case is a cold isolate serving one
 * request: two round trips instead of one, on a hop that was already a network
 * call. That is the price of the deadline meaning what it says, and it is the
 * cheapest place to pay it — the alternative is remembering this check in every
 * page and every route, which is the omission that produced this gap.
 */
async function demoWindowFor(request: NextRequest, userId: string): Promise<DemoWindowGate> {
  const now = new Date()
  const nowMs = now.getTime()

  let read = cacheGet(userId, nowMs)
  if (!read) {
    read = await readDemoWindowFacts(request, userId)
    cacheSet(userId, read, nowMs)
  }

  if (read.kind === 'none') return { allowed: true }
  if (read.kind === 'unreadable') return demoWindowGate(null, now)
  return demoWindowGate(read.facts, now)
}

// --- Responses ----------------------------------------------------------------

const EXPIRED_MESSAGE =
  'This demo has ended — access codes last 72 hours. Ask whoever shared the code for a fresh one.'

const UNVERIFIABLE_MESSAGE = 'We could not verify this account, so this request was blocked.'

/** True for the three refusals that mean "this demo window has closed". */
function isExpiryRefusal(code: DemoWindowRefusal | undefined): boolean {
  return code === 'demo-expired' || code === 'demo-expiry-missing' || code === 'demo-expiry-unreadable'
}

/**
 * Carry over whatever cookies updateSession() set on the response it built.
 *
 * Refusing means returning a DIFFERENT response object, and a rotated Supabase
 * token that only exists on the discarded one would be lost. That matters for
 * the 'profile-unavailable' branch, which can hit an ordinary user during a
 * blip: they should retry with the session they had, not with a stale token.
 */
function inheritCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie)
  return to
}

/**
 * Best-effort teardown of the browser's copy of a dead demo session.
 *
 * NOT the boundary — the boundary is the deadline on the profile row, which is
 * re-evaluated on every request whether or not this succeeds. This only stops a
 * session everyone already agrees is over from costing a getUser() on every
 * navigation, and stops the app from rendering a signed-in shell for an account
 * that can no longer do anything.
 * `sb-` is @supabase/ssr's cookie prefix; if it ever changes, nothing here
 * breaks, the cookies simply outlive their usefulness.
 */
function clearAuthCookies(request: NextRequest, response: NextResponse): NextResponse {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith('sb-')) {
      response.cookies.set({ name: cookie.name, value: '', maxAge: 0, path: '/' })
    }
  }
  return response
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // /agent was folded into /copilot's runs panel. A page-level redirect()
  // in app/(app)/agent/page.tsx only fires client-side once React mounts
  // (its parent layout is a client component that streams a 200 first), so
  // plain HTTP clients (curl, old bookmarks with no JS) never leave /agent.
  // Redirect here instead — middleware runs before any rendering and always
  // returns a real 307.
  if (pathname === '/agent') {
    const url = request.nextUrl.clone()
    url.pathname = '/copilot'
    return NextResponse.redirect(url)
  }

  const { response, user } = await updateSession(request)

  const isApi = pathname.startsWith('/api')
  const isPublic = publicRoutes.some(route => pathname.startsWith(route))

  if (!user) {
    // Allow public routes; API routes return their own 401s
    if (isPublic || isApi) return response

    // Redirect unauthenticated users to login
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Signed in. Everything below is the demo deadline, and it deliberately
  // covers API routes as well as pages: a demo that could no longer load a page
  // but could still POST /api/jobs/refresh would not have expired in any sense
  // the promise means.
  if (isPublic || EXPIRED_SESSION_ESCAPE_HATCHES.some(route => pathname.startsWith(route))) {
    return response
  }

  const gate = await demoWindowFor(request, user.id)
  if (gate.allowed) return response

  const expired = isExpiryRefusal(gate.code)
  const message = expired ? EXPIRED_MESSAGE : UNVERIFIABLE_MESSAGE

  if (isApi) {
    // 403, not 401: the credential is genuine and the identity is not in
    // question — the window it was issued for has closed. A 401 would read as
    // "sign in again", which is the one thing that cannot help here.
    const refusal = NextResponse.json(
      { error: expired ? 'this demo has expired' : 'account could not be verified', message },
      { status: 403 }
    )
    // Same rule as the page path below: a token rotated on the way in is worth
    // carrying over for a transient failure, and is not worth carrying over for
    // a session that is over.
    return expired ? refusal : inheritCookies(response, refusal)
  }

  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  // A hint for the login page, not a control: the page is free to ignore it,
  // and nothing downstream is allowed to trust it.
  if (expired) url.searchParams.set('demo', 'expired')

  const redirect = NextResponse.redirect(url)
  // Only tear the session down when the demo is genuinely over. An unreadable
  // profile is transient, and signing a real user out over a blip would turn a
  // retry into a support ticket.
  return expired ? clearAuthCookies(request, redirect) : inheritCookies(response, redirect)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     * - .well-known (A2A agent-card discovery is PUBLIC by protocol: a remote
     *   agent fetches /.well-known/agent-card.json with no session, and a
     *   redirect to /login breaks discovery outright — found live by the E2E
     *   matrix. The card itself contains only public metadata; the task
     *   endpoint it points at still authenticates every call by PAT.)
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|\\.well-known/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
