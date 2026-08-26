// POST /api/access/redeem — turn a code someone typed into a signed-in demo
// session, on an isolated workspace, for 72 hours.
//
// WHAT THIS ENDPOINT IS
//   The only unauthenticated route in the app that can reach the service key.
//   Everything below is arranged around that fact.
//
// THE ISOLATION ARGUMENT (why a demo session cannot read the owner's data)
//   Redemption does not grant a scoped view of the owner's account. It signs
//   the holder in as a DIFFERENT, REAL auth user with its own profile row. From
//   the first byte of the next request the session is an ordinary Supabase
//   session whose auth.uid() is the demo user's id, and every table in this
//   schema is already fenced by RLS on auth.uid() = user_id. So the owner's
//   rows are unreachable for the same reason one customer cannot read another
//   customer's: not a check in this file, not a filter someone has to remember
//   to add to a query, but the policies that were already there. There is no
//   code path from a demo session back to the owner. The owner's row is touched
//   exactly once, here, by the service key: provisionDemoPreferences copies the
//   encrypted api_keys blob and NOTHING else (an allowlist — see
//   lib/access/guardrails.ts). The owner's id never leaves this handler, is
//   never written to the demo's rows, and is never returned.
//
//   This route is the one place that steps outside RLS, because creating an
//   auth user requires the service key. That power is fenced by ordering: the
//   admin client is only ever asked to create anything AFTER a code has been
//   found by hash and passed accessCodeUsability(). No code, no user.
//
// WHERE IDENTITY COMES FROM, AND WHERE IT MAY NOT
//   One question decides which workspace a visitor is handed: which auth user
//   does this code's demo mailbox belong to. ONLY GoTrue may answer it —
//   createUser's own response, generateLink's, or getUserById — because
//   auth.users is the record the visitor has no way to write.
//
//   public.profiles must never answer it, and used to. It is a MIRROR of
//   auth.users maintained by the on_auth_user_created trigger, and the schema's
//   "Users can update own profile" policy has no WITH CHECK and no column list:
//   any signed-in user can set their own profiles.email to any string, and the
//   column carries no unique constraint. So a stranger who learned a code's demo
//   address could point that address at THEMSELVES, and a redemption that
//   resolved identity by profile lookup would have marked their profile as the
//   demo, copied the owner's model key onto it, seeded it, and filed the code's
//   audit trail under their user. The 20260803000003 lockdown trigger blocks the
//   write for profiles that are ALREADY demos, which is the wrong half — the
//   attacker's profile is an ordinary one.
//
// WHY THE DEMO ACCOUNT HAS NO PASSWORD
//   It is created with no password and its email is at a .invalid domain, which
//   RFC 2606 guarantees can never resolve. So there is no password to guess, no
//   mailbox to receive a reset, and no magic link anyone can request: the
//   sign-in below is minted server-side by the service key and consumed in the
//   same request. A valid, unexpired, unrevoked code is the ONLY way into a demo
//   workspace, which is what makes "expires in 72 hours" a real statement
//   rather than a UI convention.
//
// WHAT NEVER LEAVES THIS PROCESS
//   The plaintext code is read from the request body, normalized, hashed, and
//   dropped. It is never logged, never put in a URL or query string, never
//   written to a database column, and never echoed in a response. The database
//   only ever sees its SHA-256.

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@cello/shared'

import { createAdminClient } from '@/lib/harness/supabase-admin'
import { accessCodeUsability, hashAccessCode, looksLikeAccessCode } from '@/lib/access/codes'
import { clientHintFromHeaders, recordAccessEvent } from '@/lib/access/audit'
import { demoProfilePreferences } from '@/lib/access/guardrails'
import { seedDemoWorkspace } from '@/lib/access/seed-demo'
import { allowRedeemAttempt, clientKey } from '../rate-limit'

// node:crypto in lib/access/codes.ts and lib/access/audit.ts, and the service
// key must never be sent to an edge bundle.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Generous: the first redemption of a code also seeds a whole workspace.
export const maxDuration = 60

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * ONE message for every reason a code will not work: unknown, expired, revoked,
 * malformed. Telling the difference would turn this endpoint into an oracle —
 * "expired" means the code EXISTS, which is exactly the bit a guesser wants and
 * the only expensive bit to find. The person holding a genuinely expired code
 * is not left stranded: the owner can see its state on their own dashboard and
 * issue another.
 */
const REFUSAL = "That code isn't valid. Ask whoever shared it for a new one."

/**
 * Every refusal takes at least this long. The cheap paths (malformed code, no
 * database hit) and the expensive one (found by hash, then rejected) otherwise
 * differ by a measurable round trip, which is the same oracle by a slower
 * route. Well-formedness is publicly computable from the alphabet, so padding
 * it costs nothing; existence is not, so padding it matters.
 */
const REFUSAL_FLOOR_MS = 300

/**
 * Demo mailboxes live under a domain that cannot exist. See "WHY THE DEMO
 * ACCOUNT HAS NO PASSWORD" above — this is what makes the no-mailbox claim
 * true. Overridable only because a self-hosted GoTrue could in principle
 * validate the TLD; if you override it, point it somewhere that cannot receive
 * mail, or you have quietly added a second way into a demo workspace.
 *
 * CHANGING THIS AFTER CODES HAVE BEEN REDEEMED IS A BREAKING CHANGE, and this
 * file now refuses rather than papers over it. The email is recomputed from the
 * code id on every redemption, but access_codes.demo_user_id remembers the auth
 * user minted under the OLD domain. Left unchecked, a repeat redemption would
 * sign the visitor into a brand-new, empty user at the new domain while the
 * code still pointed at the original — so resolveDemoContext(), which finds the
 * code BY demo_user_id, would attribute nothing, and the audit trail the owner
 * was promised would silently go blank. assertMailboxBelongsTo() below makes
 * that state a loud 500 with an actionable log instead.
 */
const DEMO_EMAIL_DOMAIN = process.env.DEMO_EMAIL_DOMAIN || 'demo.cello.invalid'

/**
 * A uuid that gen_random_uuid() never returns, used to spend a round trip
 * without touching anything. See refuseUnknownCode().
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export async function POST(request: NextRequest) {
  const startedAt = Date.now()

  // Before anything else, including reading the body: this is the throttle on
  // an unauthenticated endpoint that reaches the service key.
  const gate = allowRedeemAttempt(clientKey(request.headers))
  if (!gate.allowed) {
    console.warn(`[access/redeem] rate limited (${gate.scope})`)
    return NextResponse.json(
      { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' },
      { status: 429 }
    )
  }

  // A body that is not JSON, or has no string `code`, is indistinguishable from
  // a wrong code as far as the caller is concerned.
  let typed = ''
  try {
    const body: unknown = await request.json()
    if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
      typed = (body as { code: string }).code
    }
  } catch {
    typed = ''
  }

  // Cheap shape check first, so nonsense never costs a database round trip.
  if (!looksLikeAccessCode(typed)) return refuse(startedAt)

  const admin = createAdminClient()

  // BY HASH, never by plaintext. The column holds a SHA-256 and nothing else.
  //
  // owner_user_id is read for exactly one purpose — copying the allowlisted
  // slice of the owner's preferences onto the fresh demo profile (see
  // provisionDemoPreferences). It is never returned, never logged, and never
  // reaches the demo session.
  const codeHash = hashAccessCode(typed)
  const { data: code, error: lookupError } = await admin
    .from('access_codes')
    .select('id, owner_user_id, demo_user_id, expires_at, revoked_at, first_redeemed_at, redemption_count')
    .eq('code_hash', codeHash)
    .maybeSingle()

  if (lookupError) {
    console.error('[access/redeem] code lookup failed:', lookupError.message)
    return serverError(startedAt)
  }

  if (!code) return refuseUnknownCode(admin, startedAt)

  const usability = accessCodeUsability({
    expires_at: code.expires_at,
    revoked_at: code.revoked_at,
  })

  if (!usability.usable) {
    // The owner asked to see what was done with a code, and "someone tried to
    // use it after it lapsed" is part of that answer. We can only record this
    // for codes that exist — an unknown hash has no row to attach an event to,
    // which is the same reason it cannot be counted against anything.
    //
    // This insert is the SECOND round trip that refuseUnknownCode() spends a
    // decoy read to match. Awaiting it is deliberate: the trail is a promise to
    // the owner, and Next 14 has no after()/waitUntil here, so backgrounding it
    // would mean quietly losing events whenever the process is torn down after
    // the response.
    await recordAccessEvent(admin, {
      codeId: code.id,
      kind: 'denied',
      action: 'code.denied',
      detail: { reason: usability.reason },
      clientHint: clientHintFromHeaders(request.headers),
    })
    return refuse(startedAt)
  }

  // ---------------------------------------------------------------------
  // Past this line the code is valid. Only now may anything be created.
  // ---------------------------------------------------------------------

  let workspace: { demoUserId: string; email: string; seeded: boolean }
  try {
    workspace = await ensureDemoWorkspace(admin, {
      codeId: code.id,
      ownerUserId: code.owner_user_id,
      storedDemoUserId: code.demo_user_id,
      expiresAt: code.expires_at,
    })
  } catch (error) {
    console.error('[access/redeem] could not prepare demo workspace:', describeError(error))
    return serverError(startedAt)
  }

  // Bookkeeping BEFORE the session is handed out. If sign-in then fails we have
  // over-recorded a redemption, which is the harmless direction for an audit
  // trail; recording afterwards would silently lose sessions that did happen.
  await recordRedemptionCount(admin, {
    codeId: code.id,
    observedCount: code.redemption_count ?? 0,
    firstRedeemedAt: code.first_redeemed_at,
  })

  // The one write that must survive: lib/access/audit.ts sanitizes it, writes
  // it with the service key (the table has no insert policy, so a demo session
  // can never forge or suppress this), and never throws.
  await recordAccessEvent(admin, {
    codeId: code.id,
    kind: 'redeemed',
    action: 'code.redeem',
    target: '/dashboard',
    detail: { first_redemption: workspace.seeded },
    clientHint: clientHintFromHeaders(request.headers),
  })

  const signedIn = await signInAsDemoUser(admin, workspace.email, workspace.demoUserId)
  if (!signedIn) {
    // Everything up to here succeeded, so this leaks that the code was good.
    // Unavoidable, and inert: reaching it already required a valid code.
    return serverError(startedAt)
  }

  return NextResponse.json({
    ok: true,
    redirect: '/dashboard',
    // The code's own expiry. Safe to return — the holder is entitled to know
    // how long they have, and it says nothing about the code itself.
    expiresAt: code.expires_at,
  })
}

/**
 * The demo auth user for this code, creating and seeding it on first use.
 *
 * The email is derived from the code's ROW ID, never from the code, so it is
 * both stable across redemptions and useless to anyone who sees it.
 */
async function ensureDemoWorkspace(
  admin: AdminClient,
  code: { codeId: string; ownerUserId: string; storedDemoUserId: string | null; expiresAt: string }
): Promise<{ demoUserId: string; email: string; seeded: boolean }> {
  const email = demoEmailForCode(code.codeId)

  if (code.storedDemoUserId) {
    // THE MAILBOX AND THE RECORDED USER MUST BE THE SAME ACCOUNT.
    //
    // Everything downstream signs in by EMAIL (generateLink takes an address,
    // not an id) while this branch reports the id the code recorded. Those are
    // two different derivations of "who is this", and if they ever disagree the
    // visitor is signed into one workspace while the code — and therefore the
    // whole audit trail, which resolveDemoContext keys on demo_user_id — points
    // at another. See DEMO_EMAIL_DOMAIN above for how they come apart.
    //
    // Refusing is the restrictive choice and the honest one: the alternative is
    // a session that looks fine and records nothing.
    await assertMailboxBelongsTo(admin, email, code.storedDemoUserId, code.codeId)

    // Re-apply the demo marking rather than trusting it: self-heals a first
    // redemption that died between creating the user and marking the profile,
    // which would otherwise leave a demo workspace that no guardrail recognises
    // as one.
    await markProfileAsDemo(admin, code.storedDemoUserId, code.expiresAt)
    return { demoUserId: code.storedDemoUserId, email, seeded: false }
  }

  const demoUserId = await createOrRecoverDemoUser(admin, email, code.codeId)
  await markProfileAsDemo(admin, demoUserId, code.expiresAt)

  // Claim the code for this user, but only if nobody else has. The `is null`
  // guard makes the transition happen exactly once even if two people redeem
  // the same code at the same instant, and its result is what decides who
  // seeds — so the workspace is never seeded twice.
  const { data: claimed, error: claimError } = await admin
    .from('access_codes')
    .update({ demo_user_id: demoUserId })
    .eq('id', code.codeId)
    .is('demo_user_id', null)
    .select('id')

  if (claimError) throw new Error(`claiming demo user for code: ${claimError.message}`)

  const wonTheRace = (claimed?.length ?? 0) > 0
  if (!wonTheRace) {
    // Someone else got there first. Because the email is derived from the code
    // id, they created the same auth user we did, so there is nothing to clean
    // up — just don't seed on top of them.
    const { data: current } = await admin
      .from('access_codes')
      .select('demo_user_id')
      .eq('id', code.codeId)
      .maybeSingle()

    const winner = typeof current?.demo_user_id === 'string' ? current.demo_user_id : null

    // "They created the same auth user we did" is an ASSUMPTION about the
    // mailbox, and it is exactly the assumption DEMO_EMAIL_DOMAIN can break. If
    // the winner recorded a different id than the address we just resolved,
    // signing in by that address would hand out a session the code cannot be
    // attributed to — so refuse rather than guess which one is real.
    if (winner && winner !== demoUserId) {
      throw new Error(
        `code ${code.codeId} was claimed for a different demo user than the one its demo ` +
          `mailbox resolves to; refusing to issue a session that cannot be attributed. ` +
          `Has DEMO_EMAIL_DOMAIN changed since this code was first redeemed?`
      )
    }

    return { demoUserId: winner ?? demoUserId, email, seeded: false }
  }

  // RELEASE THE CLAIM IF PROVISIONING OR SEEDING FAILS.
  //
  // The claim above commits on its own. Without this compensation a single
  // transient failure here — a network blip mid-seed, a Supabase hiccup —
  // BRICKS THE CODE PERMANENTLY AND SILENTLY: the row now carries a
  // demo_user_id, so every later redemption takes the already-claimed branch,
  // reports success, and signs the visitor into a workspace that was never
  // seeded and never fenced. The owner hands out a code that quietly lands
  // people on an empty dashboard, with no error anywhere to explain it.
  //
  // Postgres cannot help here: the claim, the auth user and the seed are three
  // separate round trips through PostgREST, so there is no transaction to roll
  // back. Undoing the claim by hand is the compensation, and it restores the
  // exact precondition the next attempt needs — demo_user_id null, so it can
  // win the race and seed properly.
  try {
    // Provision preferences ONCE, on the redemption that won the claim — never
    // on a repeat one, which would wipe whatever the demo user has since
    // changed in Settings. Before seeding, so the seeder is free to layer
    // persona preferences on top of a workspace that is already fenced.
    await provisionDemoPreferences(admin, demoUserId, code.ownerUserId)

    // "Every feature works for real against seeded demo data" — an empty
    // workspace is a broken demo, so a seeding failure fails the redemption
    // rather than landing someone on an empty dashboard.
    await seedDemoWorkspace(admin, demoUserId)
  } catch (error) {
    const { error: releaseError } = await admin
      .from('access_codes')
      .update({ demo_user_id: null })
      .eq('id', code.codeId)
      .eq('demo_user_id', demoUserId)

    if (releaseError) {
      // The code IS now stranded, and that is worth shouting about — it is the
      // one state an owner cannot diagnose from the outside.
      console.error(
        `[access/redeem] CODE STRANDED: seeding failed for code ${code.codeId} and the ` +
          `claim could not be released (${releaseError.message}). Clear demo_user_id on ` +
          `that row to make the code usable again.`
      )
    }
    throw error
  }

  return { demoUserId, email, seeded: true }
}

/**
 * Create the demo auth user, or recover the one a previous attempt left behind.
 *
 * No password is ever set — see the file header. Both the create and the
 * recovery answer with an id that came from GoTrue and from nowhere else, which
 * is the rule this whole route depends on: see "WHERE IDENTITY COMES FROM".
 */
async function createOrRecoverDemoUser(
  admin: AdminClient,
  email: string,
  codeId: string
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Demo', is_demo: true },
    app_metadata: { is_demo: true },
  })

  if (!error && data?.user?.id) return data.user.id

  // Any failure gets the same treatment rather than matching on the error
  // message: the only recoverable cause is "already registered" (a crashed
  // earlier attempt, or a concurrent one), and that is exactly the case where
  // the lookup below finds the account. Anything else falls through to the
  // throw, which reports the original createUser failure — the more useful of
  // the two errors.
  const recovered = await authUserIdForMailbox(admin, email)
  if (recovered) return recovered

  throw new Error(
    `creating the demo user for code ${codeId}: ${error?.message ?? 'no user returned'}`
  )
}

/**
 * Which auth user does this demo mailbox belong to, according to GoTrue?
 *
 * WHY generateLink, AND NOT A PROFILE LOOKUP
 *   This is only reached when createUser failed, so the question is "who is
 *   already registered at this address?" — an identity question, and identity
 *   here may only come from auth.users (see "WHERE IDENTITY COMES FROM" at the
 *   top of this file; the profiles lookup this replaced was writable by any
 *   signed-in stranger). The admin SDK exposes no find-by-email, but
 *   generateLink answers exactly this question and answers it authoritatively:
 *   its response names the user the token was minted for. It is also the very
 *   call the sign-in performs later, so this is not a second derivation of
 *   identity that could drift from the one that ends up mattering.
 *
 * THE SIDE EFFECT, ACKNOWLEDGED
 *   It mints a one-time token that is then thrown away. Inert: the mailbox is at
 *   a domain that cannot receive mail, the token never leaves this process, and
 *   the sign-in a moment later mints a fresh one that supersedes it. Depending
 *   on the GoTrue version this call may also CREATE the account when the address
 *   has none — which in this branch is the outcome createUser was asking for
 *   anyway. Such an account misses the `is_demo` auth metadata createUser sets,
 *   and that is cosmetic: nothing in this codebase reads app_metadata.is_demo.
 *   profiles.is_demo — set by markProfileAsDemo immediately after, and what
 *   every guardrail actually reads — is applied either way.
 *
 * Returns null rather than throwing, so the caller can report the failure that
 * brought us here instead of this one.
 */
async function authUserIdForMailbox(admin: AdminClient, email: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error) return null
  const id = data?.user?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * The address GoTrue holds for an auth user, lowercased, or null when it holds
 * none. Throws if the user cannot be read at all — including "no such user",
 * which for a recorded demo_user_id is a broken invariant, not an answer.
 */
async function authEmailForUser(admin: AdminClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error) throw new Error(`looking up the demo auth user ${userId}: ${error.message}`)
  const email = data?.user?.email
  return typeof email === 'string' && email ? email.toLowerCase() : null
}

/**
 * Refuse unless the auth user the code recorded is the one that owns `email`.
 *
 * The one invariant that makes the audit trail mean anything: the session we
 * are about to mint is minted BY ADDRESS, and every later request is attributed
 * BY access_codes.demo_user_id. If those two disagree the demo still "works" —
 * which is precisely why it has to be checked rather than noticed.
 *
 * WHICH DIRECTION THIS ASKS IN, AND WHAT THAT DOES NOT PROVE
 *   GoTrue's admin API has no "which user owns this address", so this asks the
 *   question it can answer — what address does the recorded user have? — and
 *   requires it to be ours. Supabase's auth.users carries a unique index on
 *   email for non-SSO users, which is what makes that equivalent to the
 *   question we care about; but that is a fact about a schema this file does not
 *   own, so it is not treated as the last word. signInAsDemoUser checks the id
 *   GoTrue reports when it actually mints the link, and again when the token is
 *   spent. Three cheap checks, no single point of trust.
 */
async function assertMailboxBelongsTo(
  admin: AdminClient,
  email: string,
  recordedUserId: string,
  codeId: string
): Promise<void> {
  const onFile = await authEmailForUser(admin, recordedUserId)

  if (onFile !== null && onFile === email.toLowerCase()) return

  // Never logs either address: the demo one is derived from the code's row id
  // and the other belongs to whoever that user is. Ids and the code id are the
  // handles an owner or operator actually needs.
  throw new Error(
    `the demo mailbox for code ${codeId} is not the address auth holds for ${recordedUserId} ` +
      `(${onFile ? 'it holds a different one' : 'it holds none at all'}); refusing to issue a ` +
      `session that the code cannot be attributed to. Has DEMO_EMAIL_DOMAIN changed since this ` +
      `code was first redeemed?`
  )
}

/**
 * Mark the profile as a demo workspace and give it the code's expiry.
 *
 * This is what the rest of the app keys off. The guardrails that matter for a
 * demo (a small AI budget, no real outreach leaving the building) run deep
 * inside request handling where the access code is long out of scope, so the
 * fact has to live on the profile itself.
 */
async function markProfileAsDemo(admin: AdminClient, demoUserId: string, expiresAt: string): Promise<void> {
  const { error } = await admin
    .from('profiles')
    .update({ is_demo: true, demo_expires_at: expiresAt })
    .eq('id', demoUserId)

  if (error) throw new Error(`marking profile as demo: ${error.message}`)
}

/**
 * Sign the browser in as the demo user by minting a one-time email token with
 * the service key and immediately spending it on this request's cookie jar.
 *
 * generateLink does not send mail — it returns the token — which is the whole
 * point: the demo mailbox does not exist and nobody could receive one. The
 * token is single-use, consumed here, and never leaves the server.
 *
 * SIGNING IN BY ADDRESS IS ONLY SAFE BECAUSE OF `expectedUserId`. GoTrue has no
 * "mint a link for this user id", so the address is the handle — and an address
 * is a claim about identity, not identity itself. So the id is checked at all
 * three points it can be: ensureDemoWorkspace has already asked auth.users what
 * address the recorded user holds; generateLink then names the user it minted
 * THIS token for; and verifyOtp names the user the token was actually spent on.
 * The cheapest of those is also the earliest — a divergence caught before the
 * token is spent costs a 500 and no cookie at all.
 */
async function signInAsDemoUser(
  admin: AdminClient,
  email: string,
  expectedUserId: string
): Promise<boolean> {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })

  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error('[access/redeem] could not mint demo session:', error?.message ?? 'no token returned')
    return false
  }

  // BEFORE THE TOKEN IS SPENT. GoTrue is telling us who this link leads to, and
  // it is the only authority on that — nothing has written a cookie yet, so a
  // mismatch here is refused for free.
  const linkUserId = data?.user?.id
  if (typeof linkUserId === 'string' && linkUserId !== expectedUserId) {
    console.error(
      `[access/redeem] the demo mailbox's sign-in link resolves to ${linkUserId} but the code ` +
        `records ${expectedUserId}; refusing before the token is spent. Has DEMO_EMAIL_DOMAIN ` +
        `changed since this code was first redeemed?`
    )
    return false
  }

  const session = await createDemoSession()

  // FROM HERE THERE IS EXACTLY ONE WAY OUT THAT IS NOT SUCCESS: session.abandon().
  // Past this line a Set-Cookie may exist on this response, and a refusal that
  // leaves it there is not a refusal. The try/catch is not decoration — it is
  // what makes that true for a step somebody adds here LATER, which would
  // otherwise throw straight past the refusal and out through the handler with
  // the cookie still attached. See createDemoSession for the rest of the
  // argument.
  try {
    const { userId: signedInAs, error: verifyError } = await session.verify(tokenHash)

    if (verifyError) {
      console.error('[access/redeem] could not establish demo session:', verifyError)
      await session.abandon()
      return false
    }

    // Checked only when the response tells us who was signed in. It is the last
    // corroboration rather than the guarantee — an SDK that returns no user is
    // not a reason to fail a redemption whose identity has already been proved
    // twice against GoTrue.
    if (signedInAs !== null && signedInAs !== expectedUserId) {
      console.error(
        `[access/redeem] demo sign-in resolved to ${signedInAs} but the code records ` +
          `${expectedUserId}; refusing the session and clearing the cookie.`
      )
      await session.abandon()
      return false
    }

    return true
  } catch (unexpected) {
    console.error(
      '[access/redeem] demo sign-in threw after the session client was built:',
      describeError(unexpected)
    )
    await session.abandon()
    return false
  }
}

/**
 * The two things this route does with a browser session: create one, or take it
 * back. Deliberately the whole surface — see createDemoSession.
 */
interface DemoSession {
  /** Spend the one-time token on this request's cookie jar. */
  verify(tokenHash: string): Promise<{ userId: string | null; error: string | null }>
  /**
   * Undo it. Expires this request's session cookies FIRST, then makes a
   * best-effort remote revocation. Never throws.
   */
  abandon(): Promise<void>
}

/**
 * An anon-key client wired to this request's cookies, so verifying the token
 * writes the session exactly where the middleware and every server component
 * expect to find it — the same mechanism app/auth/callback/route.ts uses for
 * Google sign-in. Not the shared lib/supabase/server.ts client, which swallows
 * cookie writes (correct for Server Components, wrong here, where the write IS
 * the point).
 *
 * WHY THIS HANDS BACK A WRAPPER AND NOT THE CLIENT
 *   Because the write has to be undoable, and undoing it MUST NOT DEPEND ON A
 *   NETWORK CALL. This route used to refuse a mis-issued session by calling
 *   supabase.auth.signOut() inside a try/catch: if that call threw — Supabase
 *   unreachable, token already revoked, anything — the handler logged, returned
 *   a 500, and the Set-Cookie that verifyOtp had ALREADY written went out with
 *   it. The browser kept a working session for the wrong auth user and
 *   /dashboard simply opened; the 500 was cosmetic. A fail-open on the one
 *   branch whose entire job is to not hand out the wrong session.
 *
 *   So the cookie jar is the source of truth: every name the sign-in writes is
 *   remembered here, and abandon() expires exactly those, synchronously, with
 *   nothing awaited in front of it. The client never escapes this function,
 *   which is what stops a later edit from reaching signOut() first — there is no
 *   `.auth` to reach.
 *
 *   What this does NOT do is invalidate an access token that has already left
 *   the building. Nothing can, short of the remote revocation abandon() then
 *   attempts; the tokens minted here are only ever written to this response, so
 *   expiring that response's cookies is what "taking it back" means.
 */
async function createDemoSession(): Promise<DemoSession> {
  const cookieStore = await cookies()

  // Name -> the options it was written under, so the expiry below is scoped
  // identically. A cookie expired on the wrong path is a cookie that is still
  // there.
  const issued = new Map<string, CookieOptions>()

  const expire = (name: string, options: CookieOptions) => {
    // Empty value AND maxAge 0 AND an epoch expiry: the empty value is what a
    // reader on this response sees, the other two are what make the browser
    // drop it. Cheap to write all three; expensive to be wrong about which one
    // a given client honours.
    cookieStore.set({ ...options, name, value: '', maxAge: 0, expires: new Date(0) })
  }

  const client = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          issued.set(name, options)
          cookieStore.set({ name, value, ...options })
        },
        remove(name: string, options: CookieOptions) {
          issued.set(name, options)
          expire(name, options)
        },
      },
    }
  )

  return {
    async verify(tokenHash: string) {
      const { data, error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'magiclink',
      })
      const userId = data?.user?.id
      return {
        userId: typeof userId === 'string' ? userId : null,
        error: error ? error.message : null,
      }
    },

    async abandon() {
      // THE COOKIE COMES BACK FIRST, AND NOTHING IS AWAITED IN FRONT OF IT.
      // This is the whole refusal: it is local to this response, so there is no
      // network, no timeout and nothing to reject. Anything that can fail
      // belongs strictly after it.
      try {
        for (const [name, options] of issued) expire(name, options)
        issued.clear()
      } catch (clearError) {
        // Writing a cookie on a response we are still building should not be
        // able to fail. If it ever does, the browser may keep the session we
        // are refusing, which is the one outcome nobody can see from outside.
        console.error(
          '[access/redeem] CRITICAL: could not clear a mis-issued demo session cookie:',
          describeError(clearError)
        )
      }

      try {
        // Best effort, and only ever after the clear: this revokes the refresh
        // token at GoTrue, which a local expiry cannot do. It is also the call
        // that used to BE the refusal.
        await client.auth.signOut()
      } catch (signOutError) {
        console.error(
          '[access/redeem] could not revoke the mis-issued session remotely:',
          describeError(signOutError)
        )
      }
    },
  }
}

/**
 * Give the new demo profile the preferences a demo is allowed to have.
 *
 * WHY THE OWNER'S PREFERENCES ARE READ AT ALL
 *   "Every feature works perfectly" is not true of a workspace with no model
 *   key — scoring, tailoring and drafting would all refuse. demoProfilePreferences
 *   is an ALLOWLIST that carries across exactly one thing, the encrypted
 *   api_keys blob, and forces everything else (a $1 budget on the demo's own
 *   ledger, the metered provider, every Gmail grant off, nothing auto-sending).
 *   The owner's targeting, contacts, digest and autopilot settings stay behind.
 *
 * WHY THIS IS NOT THE OWNER'S ALLOWANCE
 *   Spend is keyed by user id, not by key. lib/access/guardrails.ts's
 *   demoSafeApiKeys re-stamps apiKeys.userId to the demo's own id at call time,
 *   so every token the demo spends is checked and billed against the demo's own
 *   $1 ledger. The key material itself is never readable from the client.
 *
 * WHY THE DEMO'S OWN PREFERENCES ARE READ TOO
 *   Only for its spend ledger. Provisioning is NOT guaranteed to run exactly
 *   once per workspace: when a first redemption fails mid-seed the compensation
 *   above releases the claim, and the next redemption runs this again on a
 *   profile that may already have spent money. Rebuilding the budget block from
 *   scratch would zero `spentUsd` every time, which would make re-entering a
 *   code a one-keystroke allowance refill and the $1 cap a decoration.
 *   demoProfilePreferences carries the ledger forward; everything else about
 *   the existing row is deliberately discarded, because a half-provisioned
 *   previous attempt is not evidence about anything.
 *
 * This is the ONLY place it can happen: seedDemoWorkspace() is handed the demo
 * user id and nothing else, so it has no way to reach the owner's row — which
 * is the right shape for a seeder, and the reason provisioning lives here.
 */
async function provisionDemoPreferences(
  admin: AdminClient,
  demoUserId: string,
  ownerUserId: string
): Promise<void> {
  const { data: owner, error: ownerError } = await admin
    .from('profiles')
    .select('preferences')
    .eq('id', ownerUserId)
    .maybeSingle()

  if (ownerError) {
    // Not fatal: demoProfilePreferences(undefined) still returns a fully fenced
    // block, so the demo is safe — it just has no model key, and the features
    // that need one will say so.
    console.error('[access/redeem] could not read owner preferences:', ownerError.message)
  }

  const { data: existing, error: existingError } = await admin
    .from('profiles')
    .select('preferences')
    .eq('id', demoUserId)
    .maybeSingle()

  // FATAL, unlike the owner read above, and for the opposite reason: not
  // knowing the owner's key costs the demo a feature, but not knowing what this
  // workspace has already spent means the write below would reset it. Failing
  // here releases the claim and the retry gets another chance to read it; the
  // only thing lost is a redemption attempt.
  if (existingError) throw new Error(`reading the demo's spend ledger: ${existingError.message}`)

  const { error } = await admin
    .from('profiles')
    .update({
      preferences: demoProfilePreferences(
        owner?.preferences as Record<string, unknown> | null | undefined,
        {},
        existing?.preferences as Record<string, unknown> | null | undefined
      ),
    })
    .eq('id', demoUserId)

  if (error) throw new Error(`provisioning demo preferences: ${error.message}`)
}

/**
 * Bump redemption_count with a COMPARE-AND-SWAP rather than a blind write.
 *
 * `update({ redemption_count: read + 1 })` is a read-modify-write across two
 * round trips: two people opening the same link at once both read 4 and both
 * write 5, so the counter — the number the owner reads to answer "how much has
 * this code been used?" — silently loses redemptions. Guarding the update with
 * `.eq('redemption_count', <what we read>)` makes the write conditional on
 * nothing having moved, which Postgres evaluates atomically inside the UPDATE,
 * so the loser matches no rows, re-reads and retries instead of overwriting.
 *
 * No SQL function and no migration needed, which matters because the counter is
 * the SUMMARY, not the record — access_code_events is the record, and it is
 * append-only and immune to this class of bug by construction. That is also why
 * a failure here is logged rather than fatal: an inaccurate summary must never
 * cost someone their demo.
 */
const REDEMPTION_COUNT_ATTEMPTS = 3

async function recordRedemptionCount(
  admin: AdminClient,
  input: { codeId: string; observedCount: number; firstRedeemedAt: string | null }
): Promise<void> {
  let expected = input.observedCount
  let firstRedeemedAt = input.firstRedeemedAt

  for (let attempt = 0; attempt < REDEMPTION_COUNT_ATTEMPTS; attempt++) {
    const nowIso = new Date().toISOString()

    const { data, error } = await admin
      .from('access_codes')
      .update({
        last_used_at: nowIso,
        // The FIRST one, so never overwritten once set.
        first_redeemed_at: firstRedeemedAt ?? nowIso,
        redemption_count: expected + 1,
      })
      .eq('id', input.codeId)
      .eq('redemption_count', expected)
      .select('id')

    if (error) {
      // Not fatal to the demo, but the owner is owed an accurate trail, so it is
      // loud in the logs.
      console.error('[access/redeem] redemption bookkeeping failed:', error.message)
      return
    }

    if ((data?.length ?? 0) > 0) return

    // Matched nothing: someone else redeemed between our read and our write.
    // Re-read and try again from the value they left behind.
    const { data: current, error: reReadError } = await admin
      .from('access_codes')
      .select('redemption_count, first_redeemed_at')
      .eq('id', input.codeId)
      .maybeSingle()

    if (reReadError || !current) {
      console.error(
        '[access/redeem] redemption bookkeeping could not re-read the code row:',
        reReadError?.message ?? 'row not found'
      )
      return
    }

    const observed = typeof current.redemption_count === 'number' ? current.redemption_count : null
    // Unchanged means the row did not lose a race — it is gone, filtered, or
    // the column is not what we think it is. Retrying would spin, so stop.
    if (observed === null || observed === expected) {
      console.error(
        `[access/redeem] redemption bookkeeping made no progress on code ${input.codeId}; ` +
          `the count may under-report. access_code_events remains the record of use.`
      )
      return
    }

    expected = observed
    firstRedeemedAt = (current.first_redeemed_at as string | null) ?? firstRedeemedAt
  }

  console.error(
    `[access/redeem] redemption bookkeeping lost ${REDEMPTION_COUNT_ATTEMPTS} races on code ` +
      `${input.codeId}; the count may under-report. access_code_events remains the record of use.`
  )
}

/** Stable per code, derived from the row id — never from the code itself. */
function demoEmailForCode(codeId: string): string {
  return `demo-${codeId.replace(/-/g, '').slice(0, 16)}@${DEMO_EMAIL_DOMAIN}`
}

async function refuse(startedAt: number): Promise<NextResponse> {
  await padToFloor(startedAt)
  return NextResponse.json({ ok: false, error: REFUSAL }, { status: 401 })
}

/**
 * Refuse a code that does not exist, having spent the same database round trips
 * a code that exists-but-is-dead spends.
 *
 * THE LEAK THIS CLOSES. Both refusals return the identical body after the same
 * REFUSAL_FLOOR_MS, so on paper they are indistinguishable — but the dead-code
 * branch awaits an audit insert the unknown-code branch has nothing to write.
 * The floor hides that only while both fit inside it: against a database a
 * couple of hundred milliseconds away, "exists" costs two round trips and
 * "unknown" costs one, and the padding stops covering the difference. The
 * response time then answers the one question the whole endpoint refuses to
 * answer in words — does this code exist? — which is exactly the bit worth
 * having, because it turns blind guessing into a search with feedback.
 *
 * The fix is symmetry, not more padding: raising the floor only moves the
 * threshold, and backgrounding the audit write would trade a timing leak for a
 * missing audit trail (Next 14 has no after()/waitUntil, so work started after
 * the response can be killed with the process). So this branch spends one
 * deliberately useless round trip — same client, same table, an id that
 * gen_random_uuid() cannot produce — and the two paths cost the same whatever
 * the latency to the database is.
 *
 * It reads rather than writes: an unknown code has no row to attach anything
 * to, and inventing one would be a far worse bug than the leak. A read and an
 * insert are not identical work, but the round trip dominates both, and what is
 * left is well inside the floor.
 */
async function refuseUnknownCode(admin: AdminClient, startedAt: number): Promise<NextResponse> {
  try {
    await admin.from('access_code_events').select('id').eq('code_id', NIL_UUID).limit(1)
  } catch {
    // A failed decoy is not a reason to answer differently — that would restore
    // the very asymmetry it exists to remove.
  }
  return refuse(startedAt)
}

/** A distinct shape from refuse(): it is our fault, not the code's, and it says
 *  nothing about whether any code exists. */
async function serverError(startedAt: number): Promise<NextResponse> {
  await padToFloor(startedAt)
  return NextResponse.json(
    { ok: false, error: 'Something went wrong on our end. Try again in a moment.' },
    { status: 500 }
  )
}

async function padToFloor(startedAt: number): Promise<void> {
  const remaining = REFUSAL_FLOOR_MS - (Date.now() - startedAt)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

/** Error text for logs only. Never includes the code — nothing here has ever
 *  seen it, and it must stay that way. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
