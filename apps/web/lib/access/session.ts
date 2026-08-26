// "Is this request a demo session, and which access code is it?"
//
// One place answers that question, because every call site that re-derived it
// would eventually derive it slightly differently — and the differences would
// be invisible until an event landed on the wrong code, or on no code at all.
//
// THE SUBJECT OF AN AUDIT DOES NOT GET A VOTE ON WHETHER IT HAPPENS
//   The caller's own cookie-scoped client is used for exactly one thing: "who
//   are you", which is Supabase's answer, not the caller's. EVERY question after
//   that — is this a demo, which code, when does it end — goes through the
//   service-role client.
//
//   This used to read profiles.is_demo with the caller's own RLS client and
//   treat `false` (or an error, or a missing row) as "not a demo, nothing to
//   record". That handed the subject of the audit trail a switch for it:
//   anything a demo session could do to that read — or to that column — would
//   silently blank its own history, and the failure mode is invisible, because
//   a suppressed trail looks exactly like an idle visitor. The 20260803000003
//   migration now blocks the column WRITE, but the fix and the backstop have to
//   be different things, so the READ moves too.
//
//   It matches the write side's posture: access_code_events deliberately has no
//   insert policy so that only the server can write the trail. Only the server
//   decides who it belongs to, as well.
//
//   AND THERE IS NO LONGER A PARAMETER TO GET WRONG. Both functions below used
//   to take the service-role client as an optional, unchecked argument "for
//   tests". One call site passing the client it already has in scope — its own
//   cookie-scoped one — would have handed the subject of the audit both the
//   determination and the write, silently: RLS answers "not a demo" to the
//   first and rejects the second, and a suppressed trail is indistinguishable
//   from an idle visitor. Nothing validated which client it was, and nothing
//   could — they are the same type. So the argument is gone; see
//   serviceRoleClient() below.
//
//   THE COST, PAID KNOWINGLY: every signed-in request now spends one
//   service-role query on the profile, where an ordinary user used to spend one
//   ordinary one. access_codes was already unreadable to the session itself (its
//   policies scope every row to owner_user_id — deliberately, so a demo cannot
//   enumerate or reason about its own access), so the service key was on this
//   path regardless; what changed is that it is now reached for first rather
//   than second.
//
// WHAT THIS IS NOT
//   This is NOT the isolation boundary. Isolation comes from the demo being a
//   real auth user with its own rows, enforced by the RLS policies that already
//   exist on every table — see the migration's header. This function only
//   answers "who should this activity be attributed to", plus a convenience
//   `active` flag. So when the lookup fails it returns null and logs: a request
//   that cannot be attributed loses its audit row, which is a real cost, but it
//   cannot leak anything, because nothing here grants access to anything.
//
//   The corollary matters: never gate a demo restriction on `resolveDemoContext`
//   returning non-null. Guardrails must read profiles.is_demo directly, which is
//   exactly why the migration put that column on profiles.
//
// Server-only: reaches for the service key. Never import from a client component.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { accessCodeUsability } from './codes'
import { isDemoProfile } from './guardrails'
import {
  clientHintFromHeaders,
  recordAccessEvent,
  withAuditDeadline,
  type AccessEventInput,
} from './audit'
import { scrubAuditText } from './scrub'

const PROFILES_TABLE = 'profiles'
const CODES_TABLE = 'access_codes'

export interface DemoContext {
  /** Always true. The type is a literal so `if (ctx)` reads as "is a demo". */
  isDemo: true
  /** The demo workspace's auth user — the one RLS scopes every row to. */
  demoUserId: string
  /**
   * The access code this workspace was created by, or null when no code row
   * points at it any more (the owner deleted it, or the profile was seeded by
   * hand). Null means "cannot be attributed", NOT "not a demo".
   */
  codeId: string | null
  /**
   * Still inside its window and not revoked. Computed from the code AND the
   * profile, taking the stricter of the two, and FAILS CLOSED on an unreadable
   * timestamp — same rule as accessCodeUsability, for the same reason: every
   * comparison against NaN is false, so the naive check leaves a corrupt row
   * working forever.
   */
  active: boolean
  /** The effective deadline — the earlier of the code's and the profile's. */
  expiresAt: string | null
}

interface DemoProfileRow {
  is_demo?: boolean | null
  demo_expires_at?: string | null
}

interface DemoCodeRow {
  id?: string | null
  expires_at?: string | null
  revoked_at?: string | null
}

/** A DB error is a sentence; anything longer is a payload echoed back at us. */
const LOG_MESSAGE_MAX_CHARS = 300

function logLookupFailure(phase: string, message: string): void {
  // Structured single line, matching lib/observability/log.ts. No user id, no
  // code, no email — this is a lookup failure, not a place to describe anyone.
  // The message is bounded and passed through the audit text gate anyway,
  // because a PostgREST error quotes the offending value back at you and that
  // value came from a caller.
  console.error(
    `[access:session] ${JSON.stringify({
      at: new Date().toISOString(),
      scope: 'access-session',
      phase,
      message: scrubAuditText(message, LOG_MESSAGE_MAX_CHARS).slice(0, LOG_MESSAGE_MAX_CHARS),
    })}`
  )
}

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  // An unreadable timestamp wins: it is the one accessCodeUsability will refuse
  // on, and surfacing it keeps the flag and the displayed deadline consistent.
  if (!Number.isFinite(ta)) return a
  if (!Number.isFinite(tb)) return b
  return ta <= tb ? a : b
}

/**
 * The service-role client this module uses, built HERE and nowhere else.
 *
 * There is deliberately no way for a caller to supply one — see the header. A
 * deployment missing the service key cannot answer "is this a demo" at all, so
 * this returns null and logs: the request loses its audit row, which is a real
 * cost, but it grants nothing (see WHAT THIS IS NOT), and guessing "probably
 * not a demo" from a client we could not build would be strictly worse.
 *
 * createAdminClient() caches its client, so asking twice in one request is free.
 */
function serviceRoleClient(): SupabaseClient | null {
  try {
    return createAdminClient()
  } catch (err) {
    logLookupFailure('admin', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * The ONE thing the caller's own client is asked. getUser() verifies the token
 * with the auth server rather than trusting a decoded cookie, so this is
 * Supabase's answer to "who are you", not the session's claim about it.
 */
async function currentUserId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getUser()
    if (error) return null
    return data?.user?.id ?? null
  } catch (err) {
    // A cookie store that throws is a broken request, not a demo. Logged
    // because it is a lookup we could not perform, same as the others.
    logLookupFailure('auth', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Resolve the demo context for a request, or null when the request is not a
 * demo session — which also covers "not signed in", "the profile could not be
 * read" and "no service-role client could be built". Those are refusals to
 * answer, not answers, and each one is logged.
 *
 * Never throws.
 */
export async function resolveDemoContext(supabase: SupabaseClient): Promise<DemoContext | null> {
  const userId = await currentUserId(supabase)
  // Checked BEFORE the service-role client is reached for, so an anonymous
  // request to an instrumented route costs nothing and logs nothing.
  if (!userId) return null
  const client = serviceRoleClient()
  if (!client) return null
  return resolveForUser(client, userId)
}

/**
 * The lookup itself, given the service-role client and the id Supabase just
 * confirmed. Split out because the determination needs a service-role client
 * and so does the write, and both must be answered by that authority rather
 * than by the caller's own session — see the header.
 *
 * Never throws.
 */
async function resolveForUser(
  client: SupabaseClient,
  userId: string
): Promise<DemoContext | null> {
  try {
    const { data: profileData, error: profileError } = await client
      .from(PROFILES_TABLE)
      .select('is_demo, demo_expires_at')
      .eq('id', userId)
      .maybeSingle()

    if (profileError) {
      logLookupFailure('profile', profileError.message)
      return null
    }
    const profile = (profileData ?? null) as DemoProfileRow | null
    // isDemoProfile, not `profile.is_demo`: a row carrying a demo deadline is a
    // demo even if the flag was dropped by a partial update, and the two signals
    // OR'd is the restrictive reading. Same rule the guardrails use, so a
    // session cannot be a demo for one and an ordinary user for the other.
    const facts = {
      is_demo: profile?.is_demo ?? null,
      demo_expires_at: profile?.demo_expires_at ?? null,
    }
    // The common case, and the ONLY thing that ends this early: a row that
    // exists and says "ordinary user". A MISSING row proves nothing — it is
    // what a deleted profile looks like, and "delete the row that says I am
    // being watched" must not be a way to stop being watched. So an absent
    // profile falls through to the codes table below, which is the other place
    // that knows.
    if (profile && !isDemoProfile(facts)) return null

    const profileExpiresAt = facts.demo_expires_at

    // Same service-role client for the code row: its policies scope every row to
    // owner_user_id, so the session itself could never read this.
    let code: DemoCodeRow | null = null
    try {
      const { data, error } = await client
        .from(CODES_TABLE)
        .select('id, expires_at, revoked_at')
        // Nothing declares demo_user_id unique, and the owner could in principle
        // point a second code at the same workspace. Newest wins, so the context
        // describes the code that is actually in play.
        .eq('demo_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw new Error(error.message)
      code = (data ?? null) as DemoCodeRow | null
    } catch (err) {
      logLookupFailure('code', err instanceof Error ? err.message : String(err))
    }

    // No profile row AND no code pointing here: an ordinary user whose profile
    // has not been created yet, not a demo. (With a profile row present we
    // already know it says demo, so a missing code is only a lost attribution.)
    if (!profile && !code) return null

    const expiresAt = earlier(code?.expires_at ?? null, profileExpiresAt)
    const active = accessCodeUsability({
      expires_at: expiresAt,
      revoked_at: code?.revoked_at ?? null,
    }).usable

    return {
      isDemo: true,
      demoUserId: userId,
      codeId: typeof code?.id === 'string' ? code.id : null,
      active,
      expiresAt,
    }
  } catch (err) {
    logLookupFailure('resolve', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * What a feature route says about one thing a demo visitor did.
 *
 * `codeId` is absent because only this module gets to decide whose trail a row
 * belongs to. `clientHint` is absent for a different reason: it is DERIVED here
 * from the request's headers, so no call site can put a raw address or
 * user-agent in that column even by accident (audit.ts's coerceClientHint is
 * the backstop; this is the door).
 */
export interface DemoEventInput extends Omit<AccessEventInput, 'codeId' | 'clientHint'> {
  /**
   * The request's headers — pass `request.headers`. Optional, and the row is
   * still written without them; supplying them is what lets the owner see that
   * two different people are sharing one code.
   */
  headers?: Headers
}

/**
 * Record an event IF this request is a demo session, and do nothing otherwise.
 *
 * This is the call every feature route should reach for: it is one line and it
 * needs no knowledge of the codes tables. It WRITES nothing for the owner's own
 * traffic — so sprinkling it through the app cannot start logging a real user's
 * job search by accident.
 *
 * IT IS NOT FREE FOR AN ORDINARY USER, and no caller may claim it is. Every
 * signed-in request that reaches it pays one auth round trip (getUser verifies
 * the token with the auth server; that is the point of it) plus one
 * service-role profile read, and only then discovers there is nothing to
 * record. That cost is bounded — see below — but it is real, so instrument the
 * handful of routes whose activity the owner actually needs to see rather than
 * every route there is.
 *
 * The detail rules that matter are in lib/access/audit.ts: pass COUNTS, ENUMS
 * and IDS. Prose, addresses, secrets and anything long are dropped by the
 * sanitizer rather than written, and the drop is counted in `_dropped`.
 *
 * AWAIT IT. Two properties together are what make that safe, and only the
 * first of them used to hold:
 *
 *   1. It never throws. A failure anywhere on this path is logged and
 *      swallowed, so it cannot change what the caller returns.
 *   2. It never WAITS longer than AUDIT_DEADLINE_MS for any of it. Every step
 *      here is a network call, and an awaited network call with no deadline can hang for
 *      the handler's whole maxDuration — turning a request that had already
 *      done its work into a gateway timeout. The bound covers the auth round
 *      trip and both lookups as well as the insert, because any of them can be
 *      the one that hangs.
 *
 * Next 14 gives a route handler no after()/waitUntil, so a floating promise is
 * an event silently lost whenever the process is torn down after the response —
 * which is why this is awaited rather than backgrounded. Same reasoning as
 * app/api/access/redeem/route.ts.
 */
export async function recordDemoEvent(
  supabase: SupabaseClient,
  event: DemoEventInput
): Promise<void> {
  // ONE deadline around the WHOLE path, not one per query. Three sequential
  // bounds would let a request wait 3x the budget; one bound is the number the
  // doc comment above promises.
  const failure = await withAuditDeadline(async () => {
    // resolveDemoContext, not a private re-derivation of it: "whose trail is
    // this" must have exactly one answer in this codebase, and a second copy
    // here is how that stops being true. It reaches the service-role client
    // itself, which is what keeps the subject of the audit out of the
    // determination.
    const context = await resolveDemoContext(supabase)
    // Not a demo, or no code to attribute it to. Dropping the event is the
    // honest outcome, and resolveDemoContext has already logged any reason
    // worth logging.
    if (!context?.codeId) return

    // createAdminClient() caches (lib/harness/supabase-admin.ts), so this is
    // the SAME service-role client the determination just used — one authority
    // answering both "is this a demo" and "record it". The write needs a
    // service-role client regardless: access_code_events has no insert policy,
    // on purpose (see lib/access/audit.ts), so a cookie-scoped client would be
    // refused by RLS and would silently write nothing.
    const client = serviceRoleClient()
    if (!client) return

    const { headers, ...rest } = event
    await recordAccessEvent(client, {
      ...rest,
      codeId: context.codeId,
      clientHint: headers ? clientHintFromHeaders(headers) : null,
    })
  })
  if (failure) logLookupFailure('record', failure)
}
