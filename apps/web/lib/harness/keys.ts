// Load + decrypt a user's LLM API keys through the service-role client.
//
// This mirrors getDecryptedApiKeys() from lib/apikeys.ts but reads via the
// admin client instead of the cookie-scoped server client, so it works in BOTH
// request and cron contexts (the cron route has no user session). Keys live
// encrypted at profiles.preferences.api_keys (NOT profiles.api_keys, which does
// not exist in prod). Never log or return raw key values elsewhere.
//
// ---------------------------------------------------------------------------
// DEMO CHOKEPOINT — why the demo guards live in the key loaders
// ---------------------------------------------------------------------------
// This loader and its request-context sibling (lib/apikeys.ts) are imported by
// almost every feature that can reach a paid model: the harness executor,
// autopilot, the outreach judge, resume upload/optimize/documents, copilot,
// company resolve, the scraper trigger, gmail sync.
//
// THE WAIST IS applyDemoKeyGuards, NOT THIS PAIR OF FILES. That distinction is
// not pedantry — this header used to assert that "nothing calls a provider
// without first asking one of them for a key", and it was FALSE. A third file,
// lib/outreach/config.ts's readOutreachConfig, read profiles.preferences itself
// and handed a decrypted OpenRouter key straight to makeLlmRunner, which is how
// /api/outreach/draft and /api/outreach/follow-up reached a model without
// passing through either loader; an expired demo could still spend through
// them. The gap is closed by making that third reader end on the same function
// this one does, so the three key sources today are:
//
//     lib/harness/keys.ts     loadApiKeys          (admin / cron context)
//     lib/apikeys.ts          getDecryptedApiKeys  (request context)
//     lib/outreach/config.ts  readOutreachConfig   (outreach prefs + keys)
//
// all of which finish on applyDemoKeyGuards below.
// lib/access/demo-chokepoints.test.ts pins that list at three and fails if a
// fourth appears, because "it turned out there was another one" is exactly the
// shape of the bug this comment used to be.
//
// So both demo guarantees that concern MONEY and TIME are enforced in one
// function, instead of in ~25 route handlers that would each have to remember:
//
//   * SPEND ATTRIBUTION — demoSafeApiKeys re-stamps the returned blob with the
//     demo's OWN user id and pins the provider back to the metered backend.
//     lib/harness/spend.ts is keyed entirely by user id, and lib/harness/llm.ts
//     only meters when provider === 'openrouter', so those two rewrites are
//     exactly what keeps a demo inside its own $1 ledger instead of drawing on
//     the owner's allowance — or, on a local provider, on nothing at all.
//
//   * EXPIRY AT USE TIME — assertDemoSessionActive runs on EVERY load, so a
//     session established at hour 71 stops being able to spend at hour 72 even
//     though its auth cookie is still perfectly valid. Enforcing expiry only at
//     redemption would make "72 hours" a promise about issuing codes rather
//     than about access. This is the cheapest place to check it on a path that
//     spends money: the profile row is already being read to get the keys, so
//     it costs no extra query, and a new metered route inherits it without
//     knowing it exists.
//
//     IT IS NOT THE ONLY PLACE, AND MUST NOT BE. A key load is not the only
//     thing a session does — browsing seeded jobs, saving a note and GET
//     /api/digest ask nobody for a key, so the deadline is ALSO enforced at the
//     session boundary in middleware.ts, which is what makes "72 hours of
//     access" true rather than "72 hours of AI". Middleware never runs for the
//     harness or for cron, so this check stays exactly where it is.
//
// SENDING is deliberately NOT enforced here — delivering mail needs a Gmail
// token, not an API key, so a send never passes through this file. That guard
// lives at the two routes that can deliver: app/api/outreach/send and
// app/api/digest/send. lib/access/demo-chokepoints.test.ts holds both halves of
// that claim in place across files.

import { decrypt, isEncrypted } from '@/lib/crypto'
import {
  DemoAccessError,
  assertDemoSessionActive,
  demoSafeApiKeys,
  demoSessionGate,
  type DemoProfileFacts,
} from '@/lib/access/guardrails'
import { resolveProviderPreferences } from './providers'
import { REASONING_EFFORTS, type AdminClient, type DecryptedApiKeys, type ReasoningEffort } from './types'

/**
 * The exact profile columns a key loader must select.
 *
 * Shared as one constant so this loader and lib/apikeys.ts cannot drift: a
 * loader that forgot `is_demo` would read `undefined`, and `undefined` is
 * indistinguishable from "not a demo" to any reader that is not looking for the
 * difference. One string means the mistake can only be made once.
 *
 * `id` is selected rather than reused from the `userId` argument so spend is
 * attributed to the row we actually read, not to the id we hoped to read.
 */
export const KEY_LOADER_PROFILE_COLUMNS = 'id, preferences, is_demo, demo_expires_at'

/** The same columns MINUS the two the access-codes migration adds. */
export const KEY_LOADER_PROFILE_COLUMNS_PRE_MIGRATION = 'id, preferences'

/** The shape KEY_LOADER_PROFILE_COLUMNS returns. All fields defensive. */
export interface KeyLoaderProfileRow {
  id?: string | null
  preferences?: unknown
  is_demo?: boolean | null
  demo_expires_at?: string | null
  /**
   * True when the row was read WITHOUT the demo columns because the database
   * does not have them yet. Distinct from `is_demo: null`, which means the
   * columns exist and this row's value was not readable.
   */
  demoColumnsAbsent?: boolean
}

/**
 * Postgres 42703 is `undefined_column`; PostgREST surfaces a stale schema cache
 * as PGRST204 and, for a select, an error whose message names the column.
 */
function isMissingColumnError(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false
  if (error.code === '42703' || error.code === 'PGRST204') return true
  return /column .*(is_demo|demo_expires_at).* does not exist/i.test(error.message || '')
}

/**
 * Read a profile for the demo guards, tolerating a schema that predates the
 * access-codes migration.
 *
 * WHY THIS EXISTS — A REAL OUTAGE, MEASURED
 *   Selecting `is_demo, demo_expires_at` makes PostgREST fail the WHOLE query
 *   when those columns are absent. Because api_keys live in the same row, a
 *   missing column meant NO KEY LOADED ANYWHERE: an audit against a build of
 *   this tree returned {"hasKey":false,"canRunLlm":false} for a user whose key
 *   was plainly present, with `column profiles.is_demo does not exist` in the
 *   log, while two older builds returned hasKey:true.
 *
 *   Worse, it deadlocks: the settings routes select the same columns, so the
 *   owner could not save a key or a budget either. The only escape was applying
 *   a migration the product gives you no way to reach.
 *
 * WHY TREATING A MISSING COLUMN AS "NOT A DEMO" IS CORRECT, NOT A COMPROMISE
 *   applyDemoKeyGuards fails CLOSED on an unreadable profile, and that is right:
 *   an absent row proves nothing, so refusing is the honest answer. But an
 *   absent COLUMN is a different fact with a stronger conclusion. profiles.is_demo
 *   only exists once 20260803000003 has run, and a demo user can only be created
 *   by a redemption that writes that column. So if the column is missing, NO
 *   DEMO USER CAN EXIST — every caller is an ordinary owner, and treating them
 *   as one is provably right rather than a relaxation.
 *
 *   The two cases are kept apart deliberately: a missing ROW still fails closed.
 */
export async function readProfileForDemoGuards(
  // Structurally typed rather than as SupabaseClient on purpose. The generated
  // Database type does not yet carry is_demo/demo_expires_at, and a precise
  // structural shape makes tsc chase supabase-js's query-builder generics until
  // it gives up (TS2589, "type instantiation is excessively deep"). The two
  // fields this function actually reads are validated defensively below, so the
  // looseness costs nothing a stricter type was buying.
  db: { from: (table: string) => any },
  userId: string,
  extraColumns = ''
): Promise<{ row: KeyLoaderProfileRow | null; error: { message?: string | null } | null }> {
  const withDemo = extraColumns
    ? `${KEY_LOADER_PROFILE_COLUMNS}, ${extraColumns}`
    : KEY_LOADER_PROFILE_COLUMNS

  // maybeSingle, not single: a missing row must arrive as `null` data rather
  // than an error, so callers reach their own fail-closed null handling instead
  // of confusing "no such row" with "no such column".
  const first = await db.from('profiles').select(withDemo).eq('id', userId).maybeSingle()
  const firstError = first.error as { code?: string; message?: string } | null
  if (!firstError) return { row: (first.data ?? null) as KeyLoaderProfileRow | null, error: null }

  if (!isMissingColumnError(firstError)) {
    return { row: (first.data ?? null) as KeyLoaderProfileRow | null, error: firstError }
  }

  // The access-codes migration has not been applied. Re-read without the demo
  // columns and mark the row so the guards know the difference between "not a
  // demo" and "could not tell".
  const base = extraColumns
    ? `${KEY_LOADER_PROFILE_COLUMNS_PRE_MIGRATION}, ${extraColumns}`
    : KEY_LOADER_PROFILE_COLUMNS_PRE_MIGRATION
  const second = await db.from('profiles').select(base).eq('id', userId).maybeSingle()
  const secondError = second.error as { message?: string } | null
  if (secondError) return { row: null, error: secondError }

  const row = (second.data ?? null) as KeyLoaderProfileRow | null
  return { row: row ? { ...row, demoColumnsAbsent: true } : null, error: null }
}

/**
 * The demo half of a key load: refuse an expired session, and make whatever
 * comes back chargeable ONLY to the caller.
 *
 * Exported so both loaders run the identical policy, and so the policy itself
 * is directly unit-testable without a database — see
 * lib/access/demo-chokepoints.test.ts.
 *
 * FAILS CLOSED ON AN UNREADABLE PROFILE. If the row did not come back we cannot
 * prove the caller is not an expired demo, so we refuse rather than guess. That
 * costs nothing in practice: profiles.preferences.api_keys is the ONLY place
 * key material is stored, so a read that returned nothing could not have
 * produced a usable key either — this turns an eventual MissingKeyError into an
 * immediate, honest DemoAccessError. It does mean a deployment whose schema
 * predates the access-codes migration refuses every key load; that is the
 * intended direction to be wrong in, and the loaders log the underlying error
 * loudly so the cause is one line away.
 */
export function applyDemoKeyGuards(
  keys: DecryptedApiKeys,
  profile: KeyLoaderProfileRow | null | undefined,
  userId: string
): DecryptedApiKeys {
  if (!profile) {
    // demoSessionGate(null) is the canonical 'profile-unavailable' refusal —
    // built here rather than hand-written so there is exactly one wording and
    // one policy. (assertDemoSessionActive(null) would throw the same error,
    // but it returns void rather than an assertion signature, so tsc could not
    // narrow `profile` past this point.)
    throw new DemoAccessError(demoSessionGate(null))
  }

  const facts: DemoProfileFacts & { id: string } = {
    id: typeof profile.id === 'string' && profile.id ? profile.id : userId,
    // A row read WITHOUT the demo columns (schema predates the access-codes
    // migration) is definitively NOT a demo — the column those users are
    // created with does not exist, so none of them do. `false` rather than
    // `null` on purpose: null means "the column exists and we could not read
    // it", which must keep failing closed. See readProfileForDemoGuards.
    is_demo: profile.demoColumnsAbsent ? false : profile.is_demo ?? null,
    demo_expires_at: profile.demoColumnsAbsent ? null : profile.demo_expires_at ?? null,
  }

  // (3) Expiry, at USE time. Throws DemoAccessError past the 72-hour deadline,
  // on a demo carrying no deadline at all, and on an unparseable one.
  assertDemoSessionActive(facts)

  // (1) Spend. A no-op for the owner's own profile — non-demo rows come back
  // byte-identical.
  return demoSafeApiKeys(keys, facts)
}

export async function loadApiKeys(admin: AdminClient, userId: string): Promise<DecryptedApiKeys> {
  const { data: profile, error } = await admin
    .from('profiles')
    .select(KEY_LOADER_PROFILE_COLUMNS)
    .eq('id', userId)
    .single()

  if (error) {
    // Loud, and without the user's key material: the likeliest causes are a
    // schema that predates the access-codes migration (the select then fails
    // whole, on the is_demo column) or a genuinely missing profile row. Both
    // end in applyDemoKeyGuards refusing below, so this line is the difference
    // between a five-second diagnosis and a mystery outage.
    console.error(`harness: profile read failed for ${userId} — ${error.message}`)
  }

  const row = (profile ?? null) as KeyLoaderProfileRow | null
  const preferences = ((row?.preferences as Record<string, unknown> | null) || {}) as Record<string, unknown>
  const encrypted = (preferences.api_keys || {}) as Record<string, string | undefined>

  const out: DecryptedApiKeys = {}
  for (const provider of ['openai', 'anthropic', 'openrouter'] as const) {
    const value = encrypted[provider]
    if (!value) continue
    try {
      out[provider] = isEncrypted(value) ? decrypt(value) : value
    } catch (err) {
      console.error(`harness: failed to decrypt ${provider} key for ${userId}`, err)
    }
  }

  // Per-user preferred model (plain string, NOT encrypted).
  const model = preferences.model
  if (typeof model === 'string' && model.trim()) out.model = model.trim()

  // Per-user LLM backend choice + default reasoning effort — neither is
  // secret, neither is encrypted. Mirrors lib/apikeys.ts's
  // getDecryptedApiKeys (the request-context sibling of this admin-context
  // loader); see that file's comment for why resolveProviderPreferences is
  // called unconditionally.
  out.provider = resolveProviderPreferences(preferences.provider)
  const reasoningEffort = preferences.reasoningEffort
  if (typeof reasoningEffort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) {
    out.reasoningEffort = reasoningEffort as ReasoningEffort
  }

  // Whose spend this is — required for the monthly cap (lib/harness/spend.ts).
  out.userId = userId

  // Last, so nothing downstream of this line can hand back a blob that skipped
  // the guards: a demo past its deadline throws here, and a live demo leaves
  // with its own user id and the metered provider.
  return applyDemoKeyGuards(out, row, userId)
}
