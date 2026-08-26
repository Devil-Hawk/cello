// The employer-board credential vault.
//
// WHAT IT HOLDS
//   Sign-ins the USER ALREADY HAS on employer job boards — the Workday tenant
//   for Acme, the Greenhouse account for Beta — so the apply engine can
//   authenticate as them instead of making a student create an account for each
//   of 200 applications a week.
//
//   It does NOT create accounts, answer CAPTCHAs, or help anything get past a
//   site that has decided to refuse automation. When a board wants a new
//   account or throws a challenge, the application becomes a prefilled handoff
//   for the human. Nothing here is shaped to support anything else, and it
//   should stay that way.
//
// WHY THIS IS NOT lib/apikeys.ts WITH A DIFFERENT TABLE
//   An API key is scoped to one product and rotates in thirty seconds. A board
//   password is, in practice, a person's real password — the one they also use
//   for email — and "rotate it" means remembering every place they reused it.
//   Same primitive (aes-256-gcm via lib/crypto.ts), completely different risk,
//   and three rules follow from that:
//
//     1. PLAINTEXT EXISTS IN EXACTLY ONE PLACE: resolveCredentialFor(), on the
//        server, at the moment something is about to authenticate. It is not on
//        any list, not in any API response, not behind a reveal button, not in
//        a log line, not in an error message. There is deliberately no way for
//        the user to read back what they typed — if they cannot remember it,
//        the answer is to save it again.
//     2. IT REFUSES TO WRITE WHEN THE ENCRYPTION IS NOT REAL. See
//        assertEncryptionUsable() below; this is the single most important
//        thing in the file.
//     3. A DEMO WORKSPACE NEVER TOUCHES IT — not read, not write, not its own
//        rows. Refused here, in RLS, and in a trigger
//        (20260803000004_apply_credentials.sql).
//
// WHAT ENCRYPTION AT REST HONESTLY BUYS
//   The key lives in the deployment's environment, not in the database, so a
//   dump of the table alone is useless. Anyone holding BOTH is holding every
//   password in it. That is what components/settings/apply-credentials-card.tsx
//   says to the user in those words, and why it recommends a dedicated
//   job-search account over a reused one. The honest statement is part of the
//   feature, not marketing copy around it.

import { createDecipheriv, scryptSync } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isEncrypted } from '@/lib/crypto'
import { isDemoProfile, type DemoProfileFacts } from '@/lib/access/guardrails'

/**
 * The Supabase client the vault operates through.
 *
 * Untyped on purpose: apply_credentials postdates @cello/shared's generated
 * Database type, the same reason app/api/access-codes/route.ts casts. Callers
 * pass their OWN cookie-scoped client so RLS applies — the vault never creates
 * a service-role client of its own, because a service-role read here would step
 * over both the owner scoping and the demo fence in one move.
 */
export type VaultClient = SupabaseClient

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/**
 * What a credential looks like to anything that is not about to authenticate.
 *
 * THERE IS NO SECRET FIELD ON THIS TYPE AND THERE MUST NEVER BE ONE. It is the
 * only shape that leaves the server, so `tsc` is the thing standing between a
 * future edit and a password in a JSON response. If a caller needs the secret
 * it must call resolveCredentialFor and be a server-side authentication path.
 */
export interface ApplyCredentialSummary {
  id: string
  label: string
  /** Normalised board host: 'acme.wd5.myworkdayjobs.com'. */
  host: string
  /** ATS family when known: 'workday', 'greenhouse'. */
  provider: string | null
  /** The username or email they sign in with. PII, shown so they can tell two accounts apart. */
  username: string
  createdAt: string
  updatedAt: string
  /** When the secret was last decrypted for an authentication attempt. */
  lastUsedAt: string | null
}

/**
 * A credential WITH its plaintext secret.
 *
 * Returned by exactly one function, to server-side callers only. Never
 * serialise this, never put it in a response body, never log it, never store it
 * on a request-scoped object that something else might dump.
 */
export interface ResolvedApplyCredential extends ApplyCredentialSummary {
  secret: string
}

export interface SaveCredentialInput {
  /** A board host or any URL on it — 'https://acme.wd5.myworkdayjobs.com/en-US/careers' works. */
  host: string
  /** The user's own name for this account. Defaults to the host. */
  label?: string | null
  /** Optional ATS family. Only ever a narrowing hint; never enough to pick between employers. */
  provider?: string | null
  username: string
  /** The password or token. Never trimmed, never logged, never returned. */
  secret: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VaultRefusal =
  /** API_ENCRYPTION_KEY is unset, too weak, or not the key actually in use. */
  | 'encryption-unavailable'
  /** The caller's profile could not be read, so we cannot prove it is not a demo. */
  | 'profile-unavailable'
  | 'demo-forbidden'
  | 'invalid-input'
  | 'not-found'
  | 'storage-failed'
  /** A stored row would not decrypt — wrong key, or a corrupted row. */
  | 'decrypt-failed'

/**
 * Every refusal this module makes.
 *
 * `message` is safe to show a user and safe to log. A credential is named by
 * its LABEL or its ID and never, under any circumstance, by its secret — which
 * is why every throw site below builds its message from those two fields only.
 * `toString`/`JSON.stringify` of one of these carries nothing sensitive, and
 * lib/apply/vault.test.ts asserts that for every error path.
 */
export class VaultError extends Error {
  readonly code: VaultRefusal
  constructor(code: VaultRefusal, message: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// "Is the encryption real?" — the point of the whole file
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS.
 *
 * lib/crypto.ts derives its key like this:
 *
 *     const rawKey = process.env.API_ENCRYPTION_KEY
 *     const ENCRYPTION_KEY = rawKey
 *       ? (isHex64(rawKey) ? Buffer.from(rawKey,'hex') : scryptSync(rawKey,'salt',32))
 *       : scryptSync(process.env.NEXT_PUBLIC_SUPABASE_URL || 'default-key', 'salt', 32)
 *
 * That last branch derives the key from a value with NEXT_PUBLIC_ in its name —
 * it is compiled into the JavaScript bundle every visitor downloads — with a
 * static salt and a published algorithm. Anyone who has ever loaded the site
 * can reconstruct that key in one line. Storing a password under it is storing
 * it in the clear with extra steps, while the column name says `encrypted_secret`
 * and the UI says "encrypted at rest". That gap is worse than not having the
 * feature, so this module refuses to write at all when it is in that state.
 *
 * It is tolerable for a rotatable API key, which is why lib/crypto.ts keeps the
 * fallback and this file does not try to change it. It is not tolerable for a
 * password.
 *
 * HOW IT IS DETECTED — by what encrypt() ACTUALLY DID, not by reading the env
 * var. Reading `process.env.API_ENCRYPTION_KEY` here would be a different
 * question from "which key is lib/crypto.ts using", because that module
 * snapshots its key at import time: a process that imported it before the
 * variable was in scope keeps using the fallback for its whole life while
 * `process.env` reads back perfectly. So the check encrypts a known,
 * non-secret probe and then asks which key can open it:
 *
 *   opens with the key derived from API_ENCRYPTION_KEY   -> real, allow
 *   opens with the browser-derivable fallback key        -> refuse
 *   opens with neither                                   -> refuse
 *
 * The derivations below MIRROR lib/crypto.ts. If that file ever changes how it
 * builds a key, this check stops matching and starts refusing every write.
 * That is the correct direction to break: a save that errors is recoverable, a
 * password stored under a key nobody understands is not.
 */

/** The probe. A fixed, public string — never a real secret, not even a fake-looking one. */
const ENCRYPTION_PROBE = 'cello:apply-vault:encryption-probe'

/**
 * Shortest passphrase accepted for API_ENCRYPTION_KEY when it is not 64 hex
 * characters.
 *
 * A heuristic, and openly one: the real guarantee is the fallback detection
 * above. But lib/crypto.ts feeds a short passphrase to scrypt with the STATIC
 * salt 'salt', so 'changeme' or 'devkey' is a precomputable key rather than a
 * secret one, and a password vault is not the place to accept that quietly.
 * Deployments that hit this get told exactly what to run.
 */
const MIN_PASSPHRASE_CHARS = 24

const HEX_64 = /^[0-9a-f]{64}$/i

export type EncryptionRefusal =
  | 'missing-key'
  | 'weak-key'
  /** encrypt() is using the key any visitor can derive from NEXT_PUBLIC_SUPABASE_URL. */
  | 'browser-derivable-key'
  /** encrypt() is using neither the configured key nor the fallback — unknown state. */
  | 'unverified'

export interface EncryptionStatus {
  ready: boolean
  reason?: EncryptionRefusal
  /** Safe to show the user and safe to log. Never contains key material. */
  message?: string
}

const READY: EncryptionStatus = { ready: true }

const SET_THE_KEY =
  'Set API_ENCRYPTION_KEY on this deployment (generate one with `openssl rand -hex 32`) and restart it.'

const REFUSAL_MESSAGES: Record<EncryptionRefusal, string> = {
  'missing-key':
    `Passwords can't be saved because this deployment has no encryption key. ${SET_THE_KEY}`,
  'weak-key':
    `Passwords can't be saved because API_ENCRYPTION_KEY is too short to be a real key. ${SET_THE_KEY}`,
  'browser-derivable-key':
    'Passwords can’t be saved: this deployment is falling back to a key derived from a public ' +
    `value that ships to every browser, so "encrypted" would not mean anything. ${SET_THE_KEY}`,
  unverified:
    `Passwords can't be saved because the encryption key in use could not be verified. ${SET_THE_KEY}`,
}

/** Mirrors lib/crypto.ts: a 64-char hex key is decoded, anything else is scrypt-derived. */
function keyFromPassphrase(raw: string): Buffer {
  return HEX_64.test(raw) ? Buffer.from(raw, 'hex') : scryptSync(raw, 'salt', 32)
}

/** Mirrors lib/crypto.ts's fallback branch — the key a browser can reconstruct. */
function browserDerivableKey(): Buffer {
  return scryptSync(process.env.NEXT_PUBLIC_SUPABASE_URL || 'default-key', 'salt', 32)
}

/** Open a lib/crypto.ts payload with a specific key. Null on any failure — never throws. */
function openWith(key: Buffer, payload: string): string | null {
  const parts = payload.split(':')
  if (parts.length !== 3) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64'))
    decipher.setAuthTag(Buffer.from(parts[1], 'base64'))
    return decipher.update(parts[2], 'base64', 'utf8') + decipher.final('utf8')
  } catch {
    // A wrong key fails the GCM auth tag. That IS the answer, not an error.
    return null
  }
}

/**
 * Memoised because the scrypt derivations cost ~100ms each and the answer
 * cannot change without the process restarting (lib/crypto.ts's key is fixed at
 * import time). Keyed on both inputs so a test that changes the environment
 * gets a fresh answer rather than a stale "ready".
 */
let cachedStatus: { key: string; status: EncryptionStatus } | null = null

/**
 * Can this deployment store a password meaningfully?
 *
 * Pure-ish and cheap after the first call, so routes can ask BEFORE the user
 * types anything — telling someone their password cannot be stored safely is
 * much better done before they type it than after.
 */
export function encryptionStatus(): EncryptionStatus {
  // UNTRIMMED, deliberately — see computeEncryptionStatus.
  const raw = process.env.API_ENCRYPTION_KEY
  const cacheKey = `${raw ?? ''} ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}`
  if (cachedStatus && cachedStatus.key === cacheKey) return cachedStatus.status

  const status = computeEncryptionStatus(raw)
  cachedStatus = { key: cacheKey, status }
  return status
}

function refuseEncryption(reason: EncryptionRefusal): EncryptionStatus {
  return { ready: false, reason, message: REFUSAL_MESSAGES[reason] }
}

/**
 * `raw` is the environment variable UNTRIMMED, because lib/crypto.ts does not
 * trim it either and this whole function is one question: WHICH KEY IS THAT
 * MODULE USING. A value carrying a stray newline out of a .env file is
 * scrypt-derived there, so it has to be scrypt-derived here too — trimming
 * first would compute a different key, fail to match, and refuse a deployment
 * whose encryption is perfectly real. Only the presence and strength tests read
 * the trimmed form, where surrounding whitespace genuinely is not key material.
 */
function computeEncryptionStatus(raw: string | undefined): EncryptionStatus {
  const trimmed = raw?.trim() ?? ''
  if (!raw || !trimmed) return refuseEncryption('missing-key')
  if (!HEX_64.test(trimmed) && trimmed.length < MIN_PASSPHRASE_CHARS) {
    return refuseEncryption('weak-key')
  }

  // What did encrypt() actually do? Everything below is a question about this
  // ciphertext, not about the environment.
  let probe: string
  try {
    probe = encrypt(ENCRYPTION_PROBE)
  } catch {
    return refuseEncryption('unverified')
  }
  if (!isEncrypted(probe)) return refuseEncryption('unverified')

  // The round trip must work, or nothing saved today can be read back tomorrow.
  try {
    if (decrypt(probe) !== ENCRYPTION_PROBE) return refuseEncryption('unverified')
  } catch {
    return refuseEncryption('unverified')
  }

  // Belt to that braces: a ciphertext that contains its own plaintext would
  // mean encrypt() is not encrypting at all. Cheap, and the failure it catches
  // is total.
  if (probe.includes(ENCRYPTION_PROBE)) return refuseEncryption('unverified')

  // THE ACTUAL QUESTION: is the key in use the configured one?
  if (openWith(keyFromPassphrase(raw), probe) === ENCRYPTION_PROBE) return READY

  // It is not. Name the state, because "you set the variable after the module
  // loaded" and "you never set it" need different fixes even though both refuse.
  if (openWith(browserDerivableKey(), probe) === ENCRYPTION_PROBE) {
    return refuseEncryption('browser-derivable-key')
  }
  return refuseEncryption('unverified')
}

/** Throwing form. Every write path and the resolve path call this first. */
function assertEncryptionUsable(): void {
  const status = encryptionStatus()
  if (!status.ready) {
    throw new VaultError('encryption-unavailable', status.message ?? REFUSAL_MESSAGES.unverified)
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const MAX_LABEL_CHARS = 120
const MAX_USERNAME_CHARS = 320
/**
 * Longest secret accepted. Generous enough for a passphrase or a long session
 * token, small enough that this table cannot be used as a blob store.
 */
const MAX_SECRET_CHARS = 512

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A URL, a host, or a host with junk around it -> the bare host we key on.
 *
 * Returns null for anything that is not a plausible board host; callers turn
 * that into an 'invalid-input' refusal. Total and side-effect free, so the same
 * function normalises what is SAVED and what is LOOKED UP — if those two ever
 * disagreed, a stored credential would simply never be found, and the user
 * would be told there is no credential while looking at one on screen.
 *
 * A leading `www.` is dropped from both sides. It is the one prefix that is
 * universally the same site, and keeping it would mean 'www.acme.com' saved
 * never matches 'acme.com' applied to.
 */
export function normalizeHost(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let value = input.trim().toLowerCase()
  if (!value) return null

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      return null
    }
  } else {
    // 'acme.com/careers', 'acme.com:443', 'user@acme.com' — take the host part.
    value = value.split('/')[0]
    const at = value.lastIndexOf('@')
    if (at >= 0) value = value.slice(at + 1)
    value = value.split(':')[0]
  }

  value = value.replace(/\.+$/, '')
  if (value.startsWith('www.')) value = value.slice(4)

  if (!value || value.length > 253 || !HOST_RE.test(value)) return null
  return value
}

/** 'Workday' -> 'workday'. Null when it could not be a provider slug. */
export function normalizeProvider(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim().toLowerCase()
  if (!value || !PROVIDER_RE.test(value)) return null
  return value
}

// ---------------------------------------------------------------------------
// Row -> summary
// ---------------------------------------------------------------------------

/**
 * The columns every LIST path selects.
 *
 * `encrypted_secret` is absent, and lib/apply/vault.test.ts fails if it ever
 * appears here. Only readCredentialRow() — the resolve path — asks for it, and
 * it is the only function in this file that mentions the column by name.
 */
export const CREDENTIAL_SUMMARY_COLUMNS =
  'id, label, host, provider, username, created_at, updated_at, last_used_at'

/** Same columns plus the ciphertext. Server-side authentication path ONLY. */
const CREDENTIAL_SECRET_COLUMNS = `${CREDENTIAL_SUMMARY_COLUMNS}, encrypted_secret`

interface CredentialRow {
  id: string
  label: string | null
  host: string | null
  provider: string | null
  username: string | null
  created_at: string
  updated_at: string | null
  last_used_at: string | null
  encrypted_secret?: string | null
}

/**
 * Built FIELD BY FIELD, never by spreading the row.
 *
 * That is the whole point: a spread would carry `encrypted_secret` straight
 * into a response the day someone widens the select list, and it would do it
 * silently. Naming each field means the type system and this function both have
 * to be edited before a secret can escape.
 */
function toSummary(row: CredentialRow): ApplyCredentialSummary {
  return {
    id: row.id,
    label: row.label ?? row.host ?? 'Saved sign-in',
    host: row.host ?? '',
    provider: row.provider ?? null,
    username: row.username ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  }
}

/** How a credential is named in a message. Label first, then id. NEVER the secret. */
function describe(row: { label?: string | null; id?: string | null }): string {
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  if (label) return `“${label}”`
  return row.id ? `credential ${row.id}` : 'that credential'
}

/**
 * What we are willing to log about a database failure.
 *
 * `details` and `hint` are DROPPED ON PURPOSE. Postgres puts the offending row's
 * column VALUES in those fields ("Failing row contains (…)", "Key (user_id,
 * host, username)=(…)"), and this table's rows are the last thing that should
 * be reconstructable from a log line. The code and the message identify the
 * problem without quoting the data.
 */
function describeDbError(error: { code?: string; message?: string } | null): string {
  if (!error) return 'unknown error'
  return `${error.code ?? 'no-code'}: ${error.message ?? 'no message'}`
}

// ---------------------------------------------------------------------------
// The demo fence, in code
// ---------------------------------------------------------------------------

const DEMO_MESSAGE = 'Demo workspaces cannot store or use employer sign-ins.'
const UNVERIFIED_MESSAGE = 'We could not verify your account, so nothing was read or written.'

/**
 * Refuse a demo workspace, and refuse a profile we cannot read.
 *
 * FAILS CLOSED for the same reason lib/access/guardrails.ts does: absence of
 * proof is not proof of absence, and the cost of blocking one real request is a
 * retry while the cost of admitting a demo is a stranger reading — or writing —
 * the owner's employer passwords.
 *
 * This is the third of three independent refusals (RLS policy, database
 * trigger, here). It is not redundant: the trigger cannot see a SELECT, and RLS
 * does not apply to a service-role client, so this is the one that holds if some
 * future caller reaches the vault with an admin client.
 */
async function assertNotDemo(client: VaultClient, userId: string): Promise<void> {
  const { data, error } = await client
    .from('profiles')
    .select('id, is_demo, demo_expires_at')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) {
    console.error(`[apply-vault] could not verify caller ${userId} is not a demo — ${describeDbError(error)}`)
    throw new VaultError('profile-unavailable', UNVERIFIED_MESSAGE)
  }
  if (isDemoProfile(data as DemoProfileFacts)) {
    throw new VaultError('demo-forbidden', DEMO_MESSAGE)
  }
}

// ---------------------------------------------------------------------------
// saveCredential
// ---------------------------------------------------------------------------

/**
 * Store (or replace) the sign-in for one board identity.
 *
 * ORDER OF CHECKS IS DELIBERATE: encryption readiness is asserted FIRST, before
 * the profile round trip and before any validation, so that the one refusal
 * that must never be skipped cannot be reached past an early return. The secret
 * has not been touched at that point either — a deployment that cannot encrypt
 * never gets the value anywhere near a query builder.
 *
 * Re-saving the same (host, username) UPDATES that row rather than adding a
 * second copy of the same password. That is what the user means by "I changed
 * my password on Acme".
 */
export async function saveCredential(
  client: VaultClient,
  userId: string,
  input: SaveCredentialInput
): Promise<ApplyCredentialSummary> {
  assertEncryptionUsable()
  await assertNotDemo(client, userId)

  const host = normalizeHost(input.host)
  if (!host) {
    throw new VaultError(
      'invalid-input',
      "That doesn't look like a job-board address. Paste the board's URL, e.g. https://acme.wd5.myworkdayjobs.com."
    )
  }

  const username = typeof input.username === 'string' ? input.username.trim() : ''
  if (!username || username.length > MAX_USERNAME_CHARS) {
    throw new VaultError('invalid-input', 'Enter the username or email you sign in with.')
  }

  // NOT TRIMMED. A leading or trailing space is a legal character in a
  // password, and silently removing one produces a credential that fails to
  // sign in with no visible cause. Only the empty string is refused.
  const secret = typeof input.secret === 'string' ? input.secret : ''
  if (!secret) {
    throw new VaultError('invalid-input', 'Enter the password for this account.')
  }
  if (secret.length > MAX_SECRET_CHARS) {
    // Says the limit, never the length of what they typed.
    throw new VaultError(
      'invalid-input',
      `That password is longer than ${MAX_SECRET_CHARS} characters, which is longer than any board accepts.`
    )
  }

  const label =
    (typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL_CHARS) : '') || host
  const provider = input.provider == null ? null : normalizeProvider(input.provider)

  // The only place a plaintext secret and a query builder are in the same
  // scope. It is encrypted on the way in and the variable is never referenced
  // again.
  const { data, error } = await client
    .from('apply_credentials')
    .upsert(
      {
        user_id: userId,
        host,
        provider,
        label,
        username,
        encrypted_secret: encrypt(secret),
      },
      { onConflict: 'user_id,host,username' }
    )
    .select(CREDENTIAL_SUMMARY_COLUMNS)
    .single()

  if (error || !data) {
    // Named by label, never by value. See describeDbError for why `details` is
    // dropped rather than logged.
    console.error(`[apply-vault] save failed for ${describe({ label })} — ${describeDbError(error)}`)
    // 42501 is the demo trigger in 20260803000004 refusing. Surfacing it as the
    // same answer assertNotDemo gives means a demo gets one consistent "no"
    // instead of a 500 that reads as our bug and invites a retry.
    if (error?.code === '42501') throw new VaultError('demo-forbidden', DEMO_MESSAGE)
    throw new VaultError('storage-failed', `Couldn't save ${describe({ label })}. Try again.`)
  }

  return toSummary(data as CredentialRow)
}

// ---------------------------------------------------------------------------
// listCredentials
// ---------------------------------------------------------------------------

/** Most credentials returned in a list. A guard against an unbounded response, not a policy. */
const MAX_LISTED = 200

/**
 * Every credential this user has stored — WITHOUT SECRET MATERIAL.
 *
 * This is the only vault function whose result is allowed to reach a browser,
 * and it is safe to because it selects a column list that does not include the
 * ciphertext and maps through toSummary(), which names every field it copies.
 * There is no option, flag, or overload that makes it return a secret; adding
 * one would defeat the design.
 */
export async function listCredentials(
  client: VaultClient,
  userId: string
): Promise<ApplyCredentialSummary[]> {
  await assertNotDemo(client, userId)

  const { data, error } = await client
    .from('apply_credentials')
    .select(CREDENTIAL_SUMMARY_COLUMNS)
    // Belt to RLS's braces, the same doubling app/api/access-codes/route.ts uses.
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_LISTED)

  if (error) {
    console.error(`[apply-vault] list failed for ${userId} — ${describeDbError(error)}`)
    throw new VaultError('storage-failed', "Couldn't load your saved sign-ins.")
  }

  return ((data ?? []) as CredentialRow[]).map(toSummary)
}

// ---------------------------------------------------------------------------
// resolveCredentialFor
// ---------------------------------------------------------------------------

/**
 * What to look a credential up by.
 *
 * A bare string is treated as a host (or a URL on one) — that is the case that
 * matters, and the one a caller holding a job posting URL already has.
 */
export type CredentialTarget =
  | string
  | {
      /** A board host or any URL on it. When present, THIS decides. */
      host?: string | null
      /** ATS family. Only consulted when no host was supplied. */
      provider?: string | null
      /** Narrows to one account when the user has two on the same board. */
      username?: string | null
    }

export interface ResolveOptions {
  /**
   * Stamp last_used_at. On by default: the resolve IS the moment the password
   * leaves the database, and that is the event the owner needs to see in their
   * settings. Turn it off only for a genuine dry run.
   */
  markUsed?: boolean
}

/**
 * The one function that returns plaintext. SERVER-SIDE, AND ONLY ON THE PATH
 * ABOUT TO AUTHENTICATE.
 *
 * MATCHING IS EXACT ON HOST, NEVER BY SUFFIX, and that is a security property
 * rather than a simplification. Every Workday customer lives on the same apex —
 * {tenant}.wd{N}.myworkdayjobs.com (lib/ats/workday.ts) — as do Greenhouse's
 * job-boards.greenhouse.io/{token} and Lever's jobs.lever.co/{slug}. A resolver
 * that walked up to the registrable domain would decide the user "has a
 * credential for myworkdayjobs.com" and post employer A's password into
 * employer B's sign-in form. There is no partial matching here at all.
 *
 * FOR THE SAME REASON A HOST MISS NEVER FALLS BACK TO THE PROVIDER. If a host
 * was supplied, the host decides; a provider-only match would be the identical
 * cross-employer mistake arriving one step later. Provider is consulted only
 * when the caller had no host to give.
 *
 * AMBIGUITY IS RESOLVED IN THE SAFE DIRECTION:
 *   - two accounts on the SAME host — a personal address and a university one,
 *     say — are both this person's account on this board, so the most recently
 *     used one is picked, deterministically, and `username` narrows it if the
 *     caller knows which;
 *   - two credentials on DIFFERENT hosts under one provider are two different
 *     employers, and there is no safe way to choose, so nothing is returned and
 *     the application becomes a handoff for the human.
 *
 * Returns null — not an error — when there is no credential. "No credential" is
 * the normal, expected case: it means the apply engine produces a prefilled
 * handoff, which is the designed behaviour, not a failure.
 */
export async function resolveCredentialFor(
  client: VaultClient,
  userId: string,
  target: CredentialTarget,
  options: ResolveOptions = {}
): Promise<ResolvedApplyCredential | null> {
  // Asserted even on a read: a row written under the browser-derivable key
  // would decrypt fine, and handing that plaintext to a login form is exactly
  // the outcome this module exists to prevent. If encryption is not real, this
  // vault has nothing trustworthy in it.
  assertEncryptionUsable()
  await assertNotDemo(client, userId)

  const spec = typeof target === 'string' ? { host: target } : (target ?? {})
  const host = spec.host == null ? null : normalizeHost(spec.host)
  const provider = spec.provider == null ? null : normalizeProvider(spec.provider)
  const username = typeof spec.username === 'string' ? spec.username.trim() : ''

  // A host that was supplied but could not be normalised must NOT silently
  // degrade into a provider lookup — that is the cross-employer mistake again.
  if (spec.host != null && !host) return null
  if (!host && !provider) return null

  let query = client.from('apply_credentials').select(CREDENTIAL_SECRET_COLUMNS).eq('user_id', userId)
  query = host ? query.eq('host', host) : query.eq('provider', provider)
  if (username) query = query.eq('username', username)

  const { data, error } = await query.limit(MAX_LISTED)

  if (error) {
    console.error(
      `[apply-vault] resolve failed for ${userId} on ${host ?? `provider ${provider}`} — ${describeDbError(error)}`
    )
    throw new VaultError('storage-failed', "Couldn't read your saved sign-ins.")
  }

  const rows = (data ?? []) as CredentialRow[]
  if (rows.length === 0) return null

  if (!host) {
    // Provider-only: distinct hosts means distinct employers. Refuse rather than
    // guess which company's password to send. Logged without any credential
    // detail beyond a count — the owner can see the rest in Settings.
    const hosts = new Set(rows.map((row) => row.host ?? ''))
    if (hosts.size > 1) {
      console.warn(
        `[apply-vault] ${hosts.size} employers stored under provider "${provider}" and no host to choose by; ` +
          'refusing to guess — this application will be handed off'
      )
      return null
    }
  }

  const row = mostRecentlyUsed(rows)
  const summary = toSummary(row)

  const ciphertext = row.encrypted_secret
  if (typeof ciphertext !== 'string' || !ciphertext) {
    console.error(`[apply-vault] ${describe(row)} has no stored secret`)
    throw new VaultError('decrypt-failed', `${describe(row)} is missing its saved password. Save it again.`)
  }

  let secret: string
  try {
    // isEncrypted() is a shape test, not a guarantee, so the decrypt is still
    // wrapped. A row that will not open is never repaired or re-read in the
    // clear — the check constraint in the migration means a plaintext password
    // could not have been stored there in the first place.
    secret = decrypt(ciphertext)
  } catch {
    // The caught error is NOT logged or re-thrown: node's crypto errors are
    // safe today, but a decrypt failure is the one place where an implementation
    // could plausibly quote the buffer it was working on, and this row is a
    // password. Our own message says which credential, and nothing else.
    console.error(`[apply-vault] ${describe(row)} could not be decrypted`)
    throw new VaultError(
      'decrypt-failed',
      `${describe(row)} could not be decrypted — this usually means the deployment's encryption key changed. Save it again.`
    )
  }

  if (options.markUsed !== false) {
    // Best effort, and deliberately not awaited into the failure path: a
    // bookkeeping write must never be the reason an application cannot be
    // submitted. A missed stamp costs the owner one line of visibility.
    const { error: stampError } = await client
      .from('apply_credentials')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('user_id', userId)
    if (stampError) {
      console.warn(`[apply-vault] could not stamp last-used on ${describe(row)} — ${describeDbError(stampError)}`)
    }
  }

  return { ...summary, secret }
}

/**
 * Deterministic pick among a user's own accounts on ONE board.
 *
 * Most recently used, then most recently updated, then oldest created. Ordered
 * in JS rather than by PostgREST so the null handling is explicit and testable:
 * a credential that has never been used sorts after every one that has, which
 * is the "keep using the account that has been working" answer.
 */
function mostRecentlyUsed(rows: CredentialRow[]): CredentialRow {
  return [...rows].sort((a, b) => {
    const used = time(b.last_used_at) - time(a.last_used_at)
    if (used !== 0) return used
    const updated = time(b.updated_at) - time(a.updated_at)
    if (updated !== 0) return updated
    return time(a.created_at) - time(b.created_at)
  })[0]
}

/** Unparseable and missing timestamps both sort last. Never NaN, which sorts unpredictably. */
function time(value: string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : 0
}

// ---------------------------------------------------------------------------
// deleteCredential
// ---------------------------------------------------------------------------

/**
 * Remove one credential. Returns false when there was nothing to remove.
 *
 * Deliberately NOT gated on encryptionStatus(). Deletion is the user's only way
 * to take a password back out of this system, and a deployment whose key went
 * missing is exactly when someone most wants to empty the vault. Refusing here
 * would turn a configuration problem into a trap.
 */
export async function deleteCredential(
  client: VaultClient,
  userId: string,
  id: string
): Promise<boolean> {
  await assertNotDemo(client, userId)

  if (!UUID_RE.test(id ?? '')) {
    // A malformed id makes Postgres raise 22P02 on the uuid comparison, which
    // surfaces as an opaque 500 instead of the "not found" it really is.
    throw new VaultError('not-found', 'That sign-in is no longer saved.')
  }

  const { data, error } = await client
    .from('apply_credentials')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')

  if (error) {
    console.error(`[apply-vault] delete failed for ${describe({ id })} — ${describeDbError(error)}`)
    throw new VaultError('storage-failed', "Couldn't remove that sign-in. Try again.")
  }

  return ((data ?? []) as Array<{ id: string }>).length > 0
}
