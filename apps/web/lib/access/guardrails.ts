// Guardrails for a demo session — the three things that make it safe to hand a
// stranger a REAL, working account.
//
// A redeemed access code signs its holder into an isolated demo workspace: a
// genuine Supabase auth user with a genuine profiles row. That is deliberate —
// it means the RLS policies already protecting every other account do the
// isolation work, and every feature runs for real against seeded demo data
// instead of through a read-only shim that lies about what the product does.
//
// That design leaves exactly three holes RLS cannot close, because none of them
// is a question about WHOSE ROWS YOU MAY READ:
//
//   1. SPEND. Model calls cost the owner real money and RLS has no opinion
//      about dollars. lib/harness/spend.ts meters against
//      profiles.preferences.budget keyed by user id, so the demo's own cap
//      governs — but only if nothing ever hands a demo request the owner's user
//      id, only if the demo's profile cannot opt OUT of metering, and only if
//      the demo cannot simply RAISE its own cap through the product's own
//      Settings. All three are reachable states; demoProfilePreferences,
//      demoSafeApiKeys and demoSettingsGate close them.
//
//      And spend.ts meters MODEL TOKENS ONLY. The owner's Hunter, Apollo,
//      Apify, Tavily, Serper, Exa and SearXNG credentials live in the same
//      `api_keys` blob as the model key, and not one of them is metered by
//      anything — so the demo is provisioned with the model key alone. See
//      DEMO_API_KEY_ALLOWLIST.
//   2. OUTREACH SENDING. Drafting, judging and previewing an email IS the demo.
//      Delivering one is not: it puts a stranger's words in a real recipient's
//      inbox, From the owner's own Gmail account, with no undo. demoSendGate.
//   3. EXPIRY AT USE TIME. 72 hours is the product promise. Enforcing it only
//      at redemption would mean a session opened at hour 71 lives as long as
//      its cookie does — the promise would be about issuing codes, not about
//      access. demoSessionGate is meant to run on every request that acts.
//
// EVERY DECISION HERE FAILS CLOSED. An unreadable timestamp, a missing expiry,
// an unreadable profile: all refuse. This codebase has already been bitten once
// by the opposite (lib/outreach/guardrails.ts's follow-up window fell through to
// `allowed: true` on a malformed date, because every comparison against NaN is
// false), and the blast radius here is a real person's job search plus their
// money.
//
// Pure and framework-free — no DB, no network — so it imports safely from route
// handlers, the harness, cron and client components alike, and so the whole
// policy is unit-testable in one file.

import { DEFAULT_GMAIL_PERMISSIONS } from '@/lib/gmail/permissions'
import { DEFAULT_PROVIDER_PREFERENCES, type DecryptedApiKeys } from '@/lib/harness/types'
import type { Gate } from '@/lib/outreach/guardrails'
import { describeTimeRemaining } from './codes'

// --- What a caller must know about the profile -------------------------------

/**
 * The columns every guardrail here needs. Both flag fields are REQUIRED rather
 * than optional on purpose: a route that selects only `id` then asks "is this a
 * demo?" would get `undefined`, and treating undefined as "not a demo" is
 * precisely the omission that lets a demo session send email. Making them
 * required moves that mistake from runtime to `tsc`.
 *
 * Both columns arrive with the access-codes migration; `is_demo` is NOT NULL
 * DEFAULT false, so a real profile reads `false`, never null. Null is still
 * accepted in the type because a hand-built row or a stale generated Database
 * type can produce it, and null must not be silently coerced to "not a demo"
 * anywhere except through the explicit reader below.
 */
export interface DemoProfileFacts {
  /**
   * profiles.id — the demo's OWN auth user id. Required only where spend is
   * attributed (demoSafeApiKeys); the gates never need it, so callers holding a
   * partial select can still ask them.
   */
  id?: string
  is_demo: boolean | null
  demo_expires_at: string | null
}

/** A profile that may not have loaded. Every gate treats absence as a refusal. */
export type MaybeDemoProfile = DemoProfileFacts | null | undefined

export type DemoRefusal =
  /** The profile row could not be read, so we cannot prove this is not a demo. */
  | 'profile-unavailable'
  | 'demo-expired'
  /** A demo profile with no deadline at all — the "lives forever" bug itself. */
  | 'demo-expiry-missing'
  | 'demo-expiry-unreadable'
  | 'demo-send-disabled'
  /** A demo tried to change a setting that is the guardrail itself. */
  | 'demo-settings-locked'

/**
 * Extends lib/outreach/guardrails.ts's Gate rather than inventing a shape, so a
 * demo refusal drops into the existing `if (!gate.allowed) return 403
 * { error: gate.reason }` handling with no new branch — see firstRefusal.
 *
 * `reason` stays terse and matches canSendNow's register ('already sent',
 * 'awaiting approval (auto-send is disabled)') because the send route puts it
 * straight into the JSON error. `message` is the fuller, friendlier sentence
 * for a surface that has room; prefer `message ?? reason` when rendering.
 */
export interface DemoGate extends Gate {
  code?: DemoRefusal
  message?: string
}

const ALLOW: DemoGate = { allowed: true }

function refuse(code: DemoRefusal, reason: string, message: string): DemoGate {
  return { allowed: false, code, reason, message }
}

/**
 * Is this profile a demo workspace?
 *
 * A profile counts as a demo if EITHER signal says so. The flag alone would be
 * the obvious reader, but a row carrying a demo deadline is a demo even if the
 * flag was dropped by a partial update — and treating it as a normal account
 * would hand it an uncapped, never-expiring session. Two signals, OR'd, is the
 * restrictive reading.
 *
 * A missing profile answers `false` here because the question is about a known
 * row. Do NOT use this to decide whether to allow something — the gates below
 * handle the unknown-profile case explicitly, and refuse.
 */
export function isDemoProfile(profile: MaybeDemoProfile): boolean {
  if (!profile) return false
  return profile.is_demo === true || Boolean(profile.demo_expires_at)
}

// --- (3) Expiry, evaluated at USE time ---------------------------------------

const EXPIRED_MESSAGE =
  'This demo has ended — access codes last 72 hours. Ask whoever shared the code for a fresh one.'

const UNVERIFIABLE_MESSAGE = 'We could not verify this account, so this action was blocked.'

/**
 * May this session still act at all?
 *
 * Intended to run on EVERY request that does something, not once at redemption.
 * A cookie outlives the code that minted it, so "the code was valid when you
 * signed in" is not the promise the product makes; "72 hours of access" is.
 *
 * Refuses on:
 *   - an unreadable profile — absence of proof is not proof of absence, and the
 *     cost of blocking a real user for one request is a retry, while the cost of
 *     allowing an expired demo is unbounded;
 *   - a demo with NO deadline — the exact shape of the bug this check exists to
 *     prevent, so it can never be the state that grants access;
 *   - a deadline that will not parse — `new Date('nope').getTime()` is NaN and
 *     `now >= NaN` is false, so the naive check would treat corruption as "not
 *     expired yet" and the session would work forever.
 *
 * A non-demo profile is always allowed: this gate has no opinion about the
 * owner's own account.
 */
export function demoSessionGate(profile: MaybeDemoProfile, now: Date = new Date()): DemoGate {
  if (!profile) {
    return refuse('profile-unavailable', 'account could not be verified', UNVERIFIABLE_MESSAGE)
  }
  if (!isDemoProfile(profile)) return { ...ALLOW }

  if (!profile.demo_expires_at) {
    return refuse('demo-expiry-missing', 'demo session has no expiry', EXPIRED_MESSAGE)
  }

  const expiresMs = new Date(profile.demo_expires_at).getTime()
  if (!Number.isFinite(expiresMs)) {
    return refuse('demo-expiry-unreadable', 'demo expiry is unreadable', EXPIRED_MESSAGE)
  }

  // `>=` not `>`: the deadline is the first instant the session is dead, which
  // is how lib/access/codes.ts's accessCodeUsability reads the same boundary.
  if (now.getTime() >= expiresMs) {
    return refuse('demo-expired', 'this demo has expired', EXPIRED_MESSAGE)
  }

  return { ...ALLOW }
}

/** Thrown by the assert* forms. Carries the gate so a handler can reuse it. */
export class DemoAccessError extends Error {
  readonly gate: DemoGate
  readonly code: DemoRefusal | undefined
  constructor(gate: DemoGate) {
    super(gate.message || gate.reason || 'This action is not available in the demo.')
    this.name = 'DemoAccessError'
    this.gate = gate
    this.code = gate.code
  }
}

/**
 * Throwing form of demoSessionGate, for code that would rather not thread a
 * gate back up (the harness, cron, a server action). Throws DemoAccessError.
 */
export function assertDemoSessionActive(profile: MaybeDemoProfile, now: Date = new Date()): void {
  const gate = demoSessionGate(profile, now)
  if (!gate.allowed) throw new DemoAccessError(gate)
}

/**
 * "2d 6h left" for a demo banner, or null when this is not a demo and no banner
 * should appear.
 *
 * Deliberately says 'expired' — never 'unknown' — for a missing or unreadable
 * deadline, so the banner can never disagree with demoSessionGate, which
 * refuses in both of those states.
 */
export function describeDemoTimeRemaining(profile: MaybeDemoProfile, now: Date = new Date()): string | null {
  if (!profile || !isDemoProfile(profile)) return null
  if (!profile.demo_expires_at) return 'expired'
  const described = describeTimeRemaining(profile.demo_expires_at, now)
  return described === 'unknown' ? 'expired' : described
}

// --- (2) Outreach sending ----------------------------------------------------

const DEMO_SEND_MESSAGE =
  'Sending is off in the demo. You can draft, judge and preview this email exactly as the real product does — ' +
  'the demo just never puts a message in a real person’s inbox.'

/**
 * May this profile deliver an outreach email right now?
 *
 * Composed as: is the session alive at all, and then, is it a demo? An expired
 * demo is refused with the expiry reason (more informative), a live demo with
 * the sending reason. Everything upstream of delivery — drafting, the judge,
 * previewing, approving, the whole queue UI — is untouched, because a demo that
 * cannot show its outreach flow is not a demo of this product.
 *
 * WHY SENDING IS THE ONE FEATURE THAT DOES NOT WORK FOR REAL: every other
 * action a demo can take writes to rows RLS already fences off, so the worst
 * case is a mess inside a workspace that gets thrown away. A sent email leaves
 * that fence permanently — it reaches a stranger, under the owner's name and
 * from the owner's mailbox, and cannot be recalled. Auto-submitting job
 * applications would be the same class of harm, but that path is already locked
 * shut product-wide (see lib/automation/capabilities.ts's AUTO_SUBMIT_AVAILABLE
 * plus autopilot.ts's independent hardcoded false), so it needs nothing here.
 *
 * Returns a Gate rather than throwing so it composes with canSendNow instead of
 * competing with it. Use assertDemoMaySend when you want the throwing form.
 */
export function demoSendGate(profile: MaybeDemoProfile, now: Date = new Date()): DemoGate {
  const session = demoSessionGate(profile, now)
  if (!session.allowed) return session
  if (!isDemoProfile(profile)) return { ...ALLOW }
  return refuse('demo-send-disabled', 'sending is turned off in the demo', DEMO_SEND_MESSAGE)
}

/**
 * Throwing form of demoSendGate.
 *
 * It returns void ON PURPOSE. A function named `assert*` that returned a gate
 * could be called for its side effect and have its answer dropped —
 * `assertDemoMaySend(profile)` on its own line would then read as a guard while
 * doing nothing at all, and the failure mode of that mistake is a real email to
 * a real person. If you want a value, call demoSendGate.
 */
export function assertDemoMaySend(profile: MaybeDemoProfile, now: Date = new Date()): void {
  const gate = demoSendGate(profile, now)
  if (!gate.allowed) throw new DemoAccessError(gate)
}

/**
 * First refusal wins; otherwise allowed.
 *
 * Exists so a route can put a demo gate in front of the existing outreach
 * guardrails as one expression — `firstRefusal(demoSendGate(profile),
 * canSendNow(message, prefs, intent))` — and keep its single
 * `if (!gate.allowed)` branch. Order matters: put the cheapest and most
 * fundamental refusal first, because that is the one the user is told about.
 */
export function firstRefusal(...gates: DemoGate[]): DemoGate {
  for (const gate of gates) if (!gate.allowed) return gate
  return { ...ALLOW }
}

// --- (1) Spend ---------------------------------------------------------------

/**
 * The demo's whole monthly AI allowance, in USD.
 *
 * One dollar buys a genuine tour — several scores, a tailored resume, a few
 * drafts — and caps what a shared code can cost the owner if it leaks. It is
 * deliberately far below spend.ts's DEFAULT_MONTHLY_USD of 10: a demo is not a
 * user, and an unattended code is a bearer credential.
 */
export const DEMO_MONTHLY_USD = 1

export interface DemoBudget {
  periodStart: string
  spentUsd: number
  monthlyUsd: number
}

/**
 * The `preferences.budget` block a demo profile is provisioned with.
 *
 * Shaped for lib/harness/spend.ts's reader, which is the only thing that ever
 * interprets it: `monthlyUsd` becomes the cap, and an empty `periodStart` fails
 * that file's `period !== currentPeriod()` test so the ledger resets to zero on
 * first read. Encoding "no period yet" as '' rather than duplicating spend.ts's
 * private "YYYY-MM" format keeps this file from silently drifting out of sync
 * with it.
 *
 * SPEND ALREADY ON THE ROW IS CARRIED FORWARD, NEVER ZEROED. Pass the demo
 * profile's CURRENT `preferences.budget` and this returns the same ledger with
 * a demo cap on top. That is a security decision, not politeness:
 * provisioning is not guaranteed to happen exactly once per workspace —
 * app/api/access/redeem/route.ts re-runs it whenever a first redemption failed
 * mid-seed and released its claim, and the retry lands on a profile that may
 * already have spent money. A block that reset `spentUsd` would turn every such
 * retry into an allowance refill, and the $1 cap would bound nothing. It is
 * also the rule lib/access/seed-demo.ts's buildDemoPreferences already follows
 * for re-seeding; the two now agree instead of one quietly undoing the other.
 *
 * `periodStart` has to travel WITH the spend or preserving it is theatre:
 * spend.ts zeroes the counter whenever the stored period is not the current
 * one, so carrying `spentUsd: 0.9` under `periodStart: ''` would read back as
 * $0.00 spent. It is only carried when there is a spend to protect — a fresh
 * workspace still gets '' and the reset-on-first-read behaviour.
 *
 * THE CAP ONLY EVER GOES DOWN, matching seed-demo.ts. A row already carrying a
 * cap below $1 keeps the lower number; provisioning must never be a way to
 * raise a spending limit.
 *
 * KNOWN, ACCEPTED LEAK: a 72-hour code that straddles a UTC month boundary gets
 * a fresh $1 on the far side, because spend.ts resets per calendar month. Worst
 * case per code is therefore $2, not $1. Fixing it properly means a per-session
 * ledger, which is a change to spend.ts; the bound is small and known, so it is
 * recorded here rather than papered over.
 */
export function demoBudget(existingBudget?: unknown): DemoBudget {
  const existing = asRecord(existingBudget)

  // `> 0` on purpose: a negative or NaN spend is corruption, and reading it as
  // "nothing spent" is the safe direction only because the cap still applies.
  const spentUsd = typeof existing.spentUsd === 'number' && existing.spentUsd > 0 ? existing.spentUsd : 0

  const periodStart =
    spentUsd > 0 && typeof existing.periodStart === 'string' && existing.periodStart
      ? existing.periodStart
      : ''

  const existingCap =
    typeof existing.monthlyUsd === 'number' && existing.monthlyUsd > 0 ? existing.monthlyUsd : null

  return {
    periodStart,
    spentUsd,
    monthlyUsd: existingCap === null ? DEMO_MONTHLY_USD : Math.min(DEMO_MONTHLY_USD, existingCap),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The ONLY credential a demo profile is ever provisioned with.
 *
 * `api_keys` is one blob holding EVERY third-party credential this product
 * knows how to store: the model keys, plus `hunter` and `apollo`
 * (lib/contacts/keys.ts), `apify` (lib/kb/connectors/apify.ts), and `tavily`,
 * `serper`, `exa`, `searxng` (lib/search/keys.ts). Copying it whole — which
 * this function used to do — handed a stranger the owner's paid contact-lookup,
 * scraping and web-search credits, and NONE of those are metered by anything:
 * lib/harness/spend.ts counts model tokens, so the $1 cap has no opinion at all
 * about a Hunter lookup or an Apify actor run. Uncapped and, since nothing
 * re-checks them per request, unexpiring too.
 *
 * So the demo gets exactly the key that makes the product work and that the
 * guardrails can actually govern: `openrouter`. It is the only backend
 * lib/harness/llm.ts meters (`metered = provider === 'openrouter' &&
 * Boolean(userId)`), it is the one demoSafeApiKeys pins the demo back onto, and
 * it is what lib/harness/llm-key-message.ts already treats as the usable key.
 *
 * `openai` and `anthropic` are deliberately NOT here even though they are model
 * keys. The demo's provider is pinned to openrouter, so the harness would never
 * reach them — and as of the langgraph port (step 12), nothing under apps/web
 * does either: app/api/agents/{analyze,coach}/route.ts both used to construct
 * '@cello/agents' createLLMClient, which PREFERS anthropic, then openai, over
 * openrouter, and would have moved a route's spend onto real provider
 * credentials while the rest of the demo stayed on the metered one. Both are
 * gone (routed through runAgentUnit's own callLlm-backed unit instead), so this
 * exclusion is now defense-in-depth rather than a live bypass it closes — kept
 * because a demo profile should never carry a credential this product's
 * guardrails can't meter, whether or not anything currently reaches for it.
 * One key, one backend, one ledger.
 */
const DEMO_API_KEY_ALLOWLIST = ['openrouter'] as const

/**
 * A key blob narrowed to what a demo may hold.
 *
 * Returns undefined when nothing survives, so the caller can leave `api_keys`
 * off the profile entirely: every reader of this blob does
 * `preferences.api_keys || {}`, so absent and empty are the same thing to them,
 * and absent is the more honest record of "this demo was given no key".
 */
function demoApiKeys(source: unknown): Record<string, unknown> | undefined {
  const keys = asRecord(source)
  const allowed: Record<string, unknown> = {}
  for (const name of DEMO_API_KEY_ALLOWLIST) {
    if (keys[name] !== undefined) allowed[name] = keys[name]
  }
  return Object.keys(allowed).length > 0 ? allowed : undefined
}

/**
 * The `preferences` a freshly provisioned demo profile should carry.
 *
 * ALLOWLIST, NOT DENYLIST. Only `api_keys` is carried over from the owner —
 * everything else the owner has configured (targeting, digest, gmail_sync,
 * contact details, autopilot settings) stays behind. A denylist would have to
 * be updated every time someone adds a preference key, and the failure mode of
 * forgetting is that owner state leaks into a stranger's workspace. An
 * allowlist forgets in the safe direction.
 *
 * `api_keys` is the one exception because a demo with no model key is not a
 * demo of this product — and it is itself narrowed by a SECOND allowlist
 * (DEMO_API_KEY_ALLOWLIST), so what crosses is the model key and nothing else.
 * Nothing ever returns key material to a client (app/api/settings/keys returns
 * only hasOpenai/hasAnthropic/hasOpenrouter), so the demo can spend against the
 * key without ever being able to read it. If the deployment has a dedicated
 * demo key, pass it in `seed.api_keys` — a seeded blob wins over the owner's,
 * and the owner's is then never copied at all. THE SEEDED BLOB IS NARROWED BY
 * THE SAME ALLOWLIST: a demo profile carrying a paid non-model credential is
 * the thing being prevented, and where the credential came from does not change
 * that. A deployment that genuinely wants to fund demo search or contact
 * lookups has to widen the allowlist here — and own the metering question that
 * comes with it — rather than slip one in through a seed.
 *
 * The four forced blocks below always beat `seed`, so no caller can loosen a
 * guardrail by passing a preference of the same name.
 *
 * `existingDemoPreferences` is the DEMO's own current preferences row, and the
 * ONLY thing read from it is the spend ledger — see demoBudget. Nothing else
 * survives, because provisioning is what makes a workspace safe and a
 * half-configured previous attempt is not evidence about anything. Omitting it
 * is safe for a genuinely fresh workspace and ONLY for that; a caller that
 * re-provisions an existing demo must pass it, or it hands out a fresh $1.
 * Deliberately a separate argument from `ownerPreferences`: the owner's ledger
 * is the owner's, and must never be copied onto a demo in either direction.
 */
export function demoProfilePreferences(
  ownerPreferences: Record<string, unknown> | null | undefined,
  seed: Record<string, unknown> = {},
  existingDemoPreferences?: Record<string, unknown> | null
): Record<string, unknown> {
  const owner = asRecord(ownerPreferences)
  const apiKeys = demoApiKeys(seed.api_keys !== undefined ? seed.api_keys : owner.api_keys)

  // The seed's own api_keys is removed BEFORE the spread rather than being
  // overwritten after it. Overwriting only works when something survives the
  // allowlist: a seed carrying nothing but non-model credentials would leave
  // `apiKeys` undefined, and `...seed` would then put the unnarrowed blob on the
  // demo profile — the exact leak this narrowing exists to stop.
  const seedWithoutApiKeys = { ...seed }
  delete seedWithoutApiKeys.api_keys

  return {
    ...seedWithoutApiKeys,
    ...(apiKeys === undefined ? {} : { api_keys: apiKeys }),

    // The demo's own cap and its own ledger, carrying forward whatever this
    // workspace has already spent. Never the owner's numbers — see
    // demoSafeApiKeys for why the two can never be confused at call time.
    budget: demoBudget(asRecord(existingDemoPreferences).budget),

    // Pinned to the metered backend. lib/harness/llm.ts only enforces the spend
    // cap when `provider === 'openrouter'`, because a local CLI or local server
    // costs nothing per token. A demo sitting on 'local-cli' would therefore run
    // UNCAPPED against the owner's subscription — so the demo does not get to
    // start there, and demoSafeApiKeys puts it back if the demo changes it in
    // Settings. This also clears localServerBaseUrl, which is an
    // attacker-controlled outbound URL in the wrong hands.
    provider: { ...DEFAULT_PROVIDER_PREFERENCES },

    // Every Gmail grant off. Delivery is already refused by demoSendGate; this
    // is the second, independent lock, and it also keeps the demo's Settings UI
    // honest about what this workspace can do.
    gmail_permissions: { ...DEFAULT_GMAIL_PERMISSIONS },

    // Belt and braces: even if a send path is reached, nothing is auto-armed.
    outreach: { ...asRecord(seed.outreach), autoSend: false },
    autopilot: { ...asRecord(seed.autopilot), autoSubmit: false },
  }
}

/**
 * Make a demo request's model calls chargeable ONLY to the demo.
 *
 * WHY A DEMO CAN NEVER DRAW ON THE OWNER'S ALLOWANCE. spend.ts is keyed
 * entirely by user id: assertWithinBudget(admin, userId) reads that user's
 * profiles.preferences.budget, and recordSpend(admin, userId, …) writes back to
 * the same row. There is no shared pool, so "whose allowance" is decided by one
 * value — `apiKeys.userId`. This function guarantees that for a demo profile
 * that value is the demo's own id, whatever the loader did. Two concrete ways
 * it could otherwise go wrong:
 *
 *   - Borrowing. The natural way to make a demo "just work" is to load the
 *     OWNER's keys (loadApiKeys(admin, ownerId)), which stamps userId =
 *     ownerId. Every call in that demo session would then check the owner's cap
 *     and bill the owner's ledger, and a leaked code would burn the owner's
 *     month. Re-stamping the id keeps the key while moving the accounting.
 *   - Metering opt-out. llm.ts computes `metered = provider === 'openrouter' &&
 *     Boolean(apiKeys.userId)`. An ABSENT userId means no cap at all, and a
 *     non-openrouter provider means no cap at all. A demo that clears its key in
 *     Settings, or switches to a local backend, would reach a model with no
 *     ceiling. Both are forced back here, at call time, not just at signup.
 *
 * Non-demo profiles are returned byte-identical — the owner's own behaviour is
 * unchanged by this file existing.
 *
 * The mismatch is logged rather than thrown: throwing would break a demo
 * mid-feature ("all the other features work perfectly" is the point), while the
 * rewrite already makes the outcome safe. It is logged loudly because a
 * mismatch means some call site is still passing the owner's identity around,
 * and that is worth fixing at the source.
 */
export function demoSafeApiKeys(
  keys: DecryptedApiKeys,
  profile: DemoProfileFacts & { id: string }
): DecryptedApiKeys {
  if (!isDemoProfile(profile)) return keys

  if (keys.userId && keys.userId !== profile.id) {
    console.error(
      `[access] demo ${profile.id} was handed keys attributed to ${keys.userId}; ` +
        `re-attributing spend to the demo so it cannot draw on another account's allowance`
    )
  }

  const next: DecryptedApiKeys = { ...keys, userId: profile.id }
  if (next.provider?.active !== 'openrouter') {
    next.provider = { ...DEFAULT_PROVIDER_PREFERENCES }
  }
  return next
}

// --- (1, continued) The settings that ARE the guardrail ----------------------

const DEMO_SETTINGS_MESSAGE =
  `The AI budget and the model key are fixed in the demo. This workspace runs on a $${DEMO_MONTHLY_USD} ` +
  'allowance and the key it was provisioned with, so a shared code cannot spend the owner’s money — ' +
  'neither can be changed from inside the demo.'

/** One builder, so both layers below hand back an identical refusal. */
function settingsRefusal(): DemoGate {
  return refuse('demo-settings-locked', 'this setting is locked in the demo', DEMO_SETTINGS_MESSAGE)
}

/**
 * May this profile edit the settings that decide what it is allowed to spend?
 *
 * WHICH SETTINGS, AND WHY THESE. Two routes write the values every other spend
 * guardrail reads:
 *   - app/api/settings/budget PUT writes preferences.budget.monthlyUsd, which
 *     IS the $1 cap. Without this check a demo raises its own ceiling to $1000
 *     — the route's own maximum — with one request, and DEMO_MONTHLY_USD
 *     becomes a default rather than a limit.
 *   - app/api/settings/keys POST/DELETE writes preferences.api_keys. A demo
 *     that swaps in key material of its own turns the owner's workspace into an
 *     outbound channel they never authorised; one that clears the key forces
 *     whatever fallback path exists next.
 *
 * WHY THIS EXISTS WHEN supabase/migrations/20260803000003 ALREADY BLOCKS BOTH.
 * That trigger is the backstop for the write paths no route handler is on — a
 * demo session holds the browser's anon key and can PATCH its own profiles row
 * directly. This is the half that runs BEFORE the write, and it is the only one
 * that can answer in a sentence a person can read: the database's answer is a
 * SQLSTATE. It also means the guarantee does not depend on a migration having
 * been applied to a particular deployment, which is the state this feature is
 * actually in today.
 *
 * DELIBERATELY STRICTER THAN THE TRIGGER, on one point. The trigger permits a
 * demo to LOWER its cap (a smaller ceiling harms nobody); this refuses every
 * budget write. The route's floor is $1, which is already the demo's cap, so
 * the only writes a demo could make are a raise or a no-op — refusing all of
 * them costs a demo nothing real and removes a comparison that would have to
 * stay correct. Rule of the file: when the two layers disagree, the narrower
 * one is the application's.
 *
 * Composed like demoSendGate: an expired demo is refused with the expiry reason
 * (more informative), a live demo with the settings reason, and a profile that
 * could not be read is refused outright — we cannot then prove the caller is
 * not a demo. A non-demo profile is always allowed; the owner's own Settings
 * are untouched by this file existing.
 */
export function demoSettingsGate(profile: MaybeDemoProfile, now: Date = new Date()): DemoGate {
  const session = demoSessionGate(profile, now)
  if (!session.allowed) return session
  if (!isDemoProfile(profile)) return { ...ALLOW }
  return settingsRefusal()
}

/**
 * insufficient_privilege — the SQLSTATE every raise in the lockdown migration
 * carries, and what PostgREST puts in `error.code`.
 */
const DEMO_LOCKDOWN_SQLSTATE = '42501'

/**
 * The lockdown trigger's own signature. Every one of its refusals is phrased
 * 'demo profiles cannot <do the thing>', and guardrails.test.ts reads the
 * migration to prove that stays true, so this pattern cannot silently drift out
 * of agreement with the SQL.
 */
const DEMO_LOCKDOWN_MESSAGE = /demo profiles cannot/i

/** The fields any PostgREST/postgres-js error exposes that we look at. */
export interface DatabaseErrorLike {
  code?: string | null
  message?: string | null
}

/**
 * Turn a database refusal from the demo lockdown into the SAME gate the
 * application layer would have returned, or null when the error is something
 * else and the caller should handle it as it always has.
 *
 * WHY A ROUTE NEEDS THIS AT ALL. demoSettingsGate runs first and catches every
 * demo we can see. The trigger catches the ones we cannot: a write we did not
 * think to gate, a deployment running code older than this file, a row whose
 * demo flags were unreadable at check time. Without this mapping that refusal
 * arrives as a bare `error` from `.update()` and the route answers 500 —
 * "something broke" — for a request that was in fact refused on purpose. Same
 * event, same answer, whichever layer sees it first.
 *
 * MATCHES ON THE SQLSTATE **AND** THE MESSAGE, deliberately. 42501 also covers
 * a plain grant or RLS denial that has nothing to do with a demo, and telling
 * the owner their settings are locked because they are a demo would be a lie
 * this file is not entitled to tell. An error that is 42501 but not the
 * lockdown's returns null and stays whatever it already was.
 */
export function demoLockdownGate(error: DatabaseErrorLike | null | undefined): DemoGate | null {
  if (!error) return null
  if (error.code !== DEMO_LOCKDOWN_SQLSTATE) return null
  if (!DEMO_LOCKDOWN_MESSAGE.test(error.message ?? '')) return null
  return settingsRefusal()
}
