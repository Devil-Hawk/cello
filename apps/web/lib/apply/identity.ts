// The identity that goes ON a job application — deliberately NOT the identity
// the account was created with.
//
// WHY THIS FILE EXISTS
//   People job-hunting routinely apply from a dedicated address. It keeps a
//   month of recruiter mail out of the inbox they live in, and it is often a
//   more professional handle than whatever they signed up with (the account
//   email is frequently a university address that expires the term after
//   graduation, which is exactly when the offers arrive). Until now
//   lib/ats-apply/index.ts#buildApplyProfile read `profiles.email` straight
//   onto every form, so the login address WAS the application address with no
//   way to say otherwise.
//
//   This module owns that separation and the one rule that makes it safe: the
//   application address is used on employer-facing surfaces ONLY. Auth,
//   billing and the user's own notifications keep using the account address —
//   see emailForAudience(), which is the executable form of that rule.
//
// WHERE IT LIVES
//   profiles.preferences.applicationIdentity (jsonb). Read through
//   resolveApplicationIdentity(); written through the settings route after
//   validateApplicationIdentityUpdate().
//
// CONFIRMATION IS NOT VERIFICATION
//   This address receives every interview reply the user will ever get, and a
//   typo in it fails silently — no bounce the user sees, no rejection, just a
//   pipeline that never answers. We cannot yet PROVE the user owns the address
//   (that needs a real send + token round trip; see EMAIL_VERIFICATION_AVAILABLE
//   below), so we do the strongest thing available without one: an address that
//   differs from the account address is not used on a single form until the
//   human has explicitly confirmed THAT EXACT STRING, and until then we fall
//   back to the account address rather than mailing into the void.
//
// Framework-free (no React, no DOM, no network) so the applier agent, the
// approve route and the settings API can all share it. The email shape check
// is imported, not rewritten — lib/contacts/parse-csv.ts#looksLikeEmail is the
// repo's one email predicate and it already guards the other surface whose
// whole purpose is reaching a human.

import { looksLikeEmail } from '@/lib/contacts/parse-csv'

/** The key under `profiles.preferences` this module owns. */
export const APPLICATION_IDENTITY_KEY = 'applicationIdentity'

/**
 * Whether Cello can PROVE the user controls the application address.
 *
 * False, and honestly so. Nothing in this repo sends a token to an arbitrary
 * address and waits for it to come back, so every "verified" claim we could
 * render today would be a claim about a checkbox the user ticked. Confirmation
 * (see confirmedEmail) is a deliberate human acknowledgement — a real gate
 * against a fat-fingered save — and it is not the same thing. The UI must say
 * "confirmed", never "verified", while this is false. See the module header of
 * lib/automation/capabilities.ts for the same pattern and the same reason: a
 * switch that claims a capability the engine does not have is worse than no
 * switch.
 */
export const EMAIL_VERIFICATION_AVAILABLE = false

/** Longest address any mail system accepts (RFC 5321). */
const MAX_EMAIL_LENGTH = 254
/** Generous cap for the free-text form fields — they land in ATS inputs, not essays. */
const MAX_FIELD_LENGTH = 200

export type IdentityNoticeCode =
  /** No address anywhere — the account has none and none was configured. */
  | 'no-account-email'
  /** A configured application address that isn't a usable address; ignored. */
  | 'invalid-application-email'
  /** Configured, differs from the account address, never confirmed; ignored. */
  | 'unconfirmed-application-email'
  /** In force: employers will reply to an address that is not the login one. */
  | 'separate-application-email'

export type IdentityNoticeSeverity = 'info' | 'warning' | 'error'

/**
 * Something the user must be told about the resolved identity. Machine-readable
 * `code` so a caller can branch; `message` because every one of these is a
 * sentence a human needs to read on the settings card.
 */
export interface IdentityNotice {
  code: IdentityNoticeCode
  severity: IdentityNoticeSeverity
  message: string
}

/**
 * What the user CONFIGURED — the stored shape at
 * `profiles.preferences.applicationIdentity`. `null` everywhere means "not
 * configured, fall back", never "blank it out on the form".
 */
export interface ApplicationIdentitySettings {
  /** Address to put on applications. null = use the account address. */
  email: string | null
  /**
   * The exact address the human confirmed they can receive mail at.
   *
   * Bound to the STRING, not to a boolean flag, on purpose: a flag stays true
   * when the address underneath it is edited by anything that isn't our own
   * form (a direct jsonb write, a future import, a bug), and "confirmed" would
   * then be a claim about an address nobody ever read.
   */
  confirmedEmail: string | null
  /** ISO timestamp of that confirmation. Informational — the string match is the gate. */
  confirmedAt: string | null
  /** Display name for forms. null = use profiles.full_name. */
  fullName: string | null
  phone: string | null
  location: string | null
  linkedin: string | null
  website: string | null
}

/** Nothing configured — every field falls back to the account. Never mutate; spread. */
export const EMPTY_APPLICATION_IDENTITY_SETTINGS: ApplicationIdentitySettings = {
  email: null,
  confirmedEmail: null,
  confirmedAt: null,
  fullName: null,
  phone: null,
  location: null,
  linkedin: null,
  website: null,
}

/** Where the resolved application address actually came from. */
export type IdentityEmailSource = 'application' | 'account' | 'none'

/** The identity as it should appear on a form, plus everything the UI must say about it. */
export interface ApplicationIdentity {
  /**
   * The address to put on an application. Empty string ONLY when neither an
   * application address nor an account address exists — see notices.
   */
  email: string
  emailSource: IdentityEmailSource
  /**
   * The account's own address, carried alongside so a caller never has to
   * re-derive it (and so emailForAudience can answer without the profile row).
   */
  accountEmail: string
  /** True when `email` is in force AND differs from `accountEmail`. */
  usesSeparateEmail: boolean
  fullName: string
  phone: string | null
  location: string | null
  linkedin: string | null
  website: string | null
  /** Ordered most-severe-first. Empty when there is nothing to say. */
  notices: IdentityNotice[]
  /** The raw configured values, so the settings card can render exactly what is stored. */
  settings: ApplicationIdentitySettings
}

/** A `profiles` row, shaped so lib/ats-apply's ProfileRowLike passes straight through. */
export interface IdentityProfileRow {
  full_name?: string | null
  /** The ACCOUNT address (auth identity). The fallback, and the only address auth/billing may use. */
  email?: string | null
  preferences?: unknown
}

// --- small tolerant readers -------------------------------------------------

/** Trim an unknown into a non-empty string, or null. Caps length so jsonb can't be used as storage. */
function str(value: unknown, max = MAX_FIELD_LENGTH): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Case-insensitive address comparison.
 *
 * The local part is technically case-sensitive per RFC 5321, but no mail
 * provider a job seeker will use treats Jane@ and jane@ as different people,
 * and treating them as different here would demand a second confirmation for
 * what is visibly the same address.
 */
function sameEmail(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Make a profile/site URL safe to drop into an ATS URL field.
 *
 * `linkedin.com/in/jane` is what people type and what several ATS fields
 * render as a dead relative link. Adding the scheme is the only edit made —
 * anything that doesn't look like a bare host is passed through untouched
 * rather than guessed at.
 */
function normalizeUrl(value: unknown): string | null {
  const raw = str(value)
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (/\s/.test(raw) || !raw.includes('.')) return raw
  return `https://${raw}`
}

// --- reading ----------------------------------------------------------------

/**
 * Read the configured identity out of a raw `profiles.preferences` blob.
 *
 * Tolerates null/undefined preferences, a missing key, and wrong types for any
 * field. Never throws.
 *
 * LEGACY FALLBACK: before this module existed, buildApplyProfile put
 * `preferences.contact.{phone,location,linkedin,website|portfolio}` on forms.
 * Those are read here when the new key doesn't carry them, so nobody loses
 * details they already entered and the first save through the settings card
 * migrates them forward. `preferences.contact.email` is deliberately NOT
 * inherited: nothing ever put it on a form, so promoting it now would silently
 * start applying under an address the user chose for something else — and it
 * would arrive unconfirmed anyway.
 *
 * @param preferences the whole `profiles.preferences` object (NOT `.applicationIdentity`)
 */
export function readApplicationIdentitySettings(preferences: unknown): ApplicationIdentitySettings {
  const prefs = record(preferences)
  const raw = record(prefs[APPLICATION_IDENTITY_KEY])
  const legacy = record(prefs.contact)

  return {
    email: str(raw.email, MAX_EMAIL_LENGTH),
    confirmedEmail: str(raw.confirmedEmail, MAX_EMAIL_LENGTH),
    confirmedAt: str(raw.confirmedAt),
    fullName: str(raw.fullName),
    phone: str(raw.phone) ?? str(legacy.phone),
    location: str(raw.location) ?? str(legacy.location),
    linkedin: normalizeUrl(raw.linkedin) ?? normalizeUrl(legacy.linkedin),
    website:
      normalizeUrl(raw.website) ?? normalizeUrl(legacy.website) ?? normalizeUrl(legacy.portfolio),
  }
}

/** Serialize back into the shape stored at `profiles.preferences.applicationIdentity`. */
export function serializeApplicationIdentity(
  settings: ApplicationIdentitySettings
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    // Nulls are omitted rather than stored: an absent key and a null key read
    // back identically through readApplicationIdentitySettings, and omitting
    // keeps the jsonb readable when someone inspects a row by hand.
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

// --- resolving --------------------------------------------------------------

/**
 * Resolve the identity to put on an application.
 *
 * EMAIL PRECEDENCE, in order:
 *   1. A configured application address that is valid AND (equal to the account
 *      address, or confirmed for that exact string)  → source 'application'
 *   2. The account address                                    → source 'account'
 *   3. Nothing — only when the account has no address either   → source 'none'
 *
 * Rule 2 is the important one. An application carrying the login address is a
 * mild annoyance; an application carrying no address is unreachable, and an
 * application carrying a typo'd address is unreachable AND invisible. So every
 * failure of the configured address (invalid, unconfirmed) falls back rather
 * than blanking, and says so in `notices`.
 *
 * The one exception: when the account has no address at all, a configured but
 * unconfirmed address is used anyway — at that point the alternative isn't the
 * login address, it's nothing.
 */
export function resolveApplicationIdentity(row: IdentityProfileRow): ApplicationIdentity {
  const settings = readApplicationIdentitySettings(row.preferences)
  const accountEmail = str(row.email, MAX_EMAIL_LENGTH) ?? ''
  const notices: IdentityNotice[] = []

  const configured = settings.email
  const configuredIsValid = configured !== null && looksLikeEmail(configured)
  const matchesAccount = sameEmail(configured, accountEmail)
  const isConfirmed = matchesAccount || sameEmail(settings.confirmedEmail, configured)

  if (configured !== null && !configuredIsValid) {
    notices.push({
      code: 'invalid-application-email',
      severity: 'error',
      message: `“${configured}” isn’t a usable email address, so applications are going out from ${
        accountEmail || 'no address at all'
      }. Fix it in Application identity.`,
    })
  }

  // Usable = valid, and either the same address the account already proves the
  // user reads, or one they explicitly confirmed. Unconfirmed-but-valid is
  // held back below unless there is no account address to fall back to.
  const usable = configuredIsValid && isConfirmed

  let email = accountEmail
  let emailSource: IdentityEmailSource = accountEmail ? 'account' : 'none'

  if (usable && configured) {
    email = configured
    emailSource = 'application'
  } else if (configuredIsValid && configured && !accountEmail) {
    // No account address to fall back to — an unconfirmed address beats none.
    email = configured
    emailSource = 'application'
    notices.push({
      code: 'unconfirmed-application-email',
      severity: 'warning',
      message: `${configured} hasn’t been confirmed, and there’s no account address to fall back to — it’s being used on applications as-is. Confirm it in Application identity.`,
    })
  } else if (configuredIsValid && configured) {
    notices.push({
      code: 'unconfirmed-application-email',
      severity: 'warning',
      message: `${configured} hasn’t been confirmed, so applications still go out from ${accountEmail}. Confirm it in Application identity to switch.`,
    })
  }

  if (!email) {
    notices.push({
      code: 'no-account-email',
      severity: 'error',
      message:
        'No email address is set anywhere, so an employer would have no way to reply. Add an application email before applying.',
    })
  }

  const usesSeparateEmail = emailSource === 'application' && !matchesAccount

  if (usesSeparateEmail) {
    notices.push({
      code: 'separate-application-email',
      severity: 'info',
      message: `Employers will reply to ${email}, not ${accountEmail || 'your account address'}.`,
    })
  }

  const severityRank: Record<IdentityNoticeSeverity, number> = { error: 0, warning: 1, info: 2 }
  notices.sort((a, b) => severityRank[a.severity] - severityRank[b.severity])

  return {
    email,
    emailSource,
    accountEmail,
    usesSeparateEmail,
    fullName: settings.fullName ?? str(row.full_name) ?? '',
    phone: settings.phone,
    location: settings.location,
    linkedin: settings.linkedin,
    website: settings.website,
    notices,
    settings,
  }
}

/**
 * Who is being written to, and therefore which address is correct.
 *
 * THE WHOLE POINT OF THIS FUNCTION: only an employer-facing surface may use
 * the application address. A password reset, a receipt, or "your autopilot run
 * failed" sent to a job-search alias the user set up for recruiter mail — an
 * address Cello has never verified and the user may check weekly — locks them
 * out of their own account, loses them money, or silently drops the one alert
 * that mattered. Those three audiences follow the ACCOUNT, which is the address
 * auth already proved they control.
 *
 * Call this instead of reaching for `identity.email`; the audience makes the
 * choice reviewable at the call site.
 */
export type EmailAudience =
  /** Anything that lands in front of an employer: ATS submissions, handoff prefills, outreach. */
  | 'employer'
  /** Sign-in, password reset, session recovery. */
  | 'auth'
  /** Invoices, spend caps, anything about money. */
  | 'billing'
  /** Cello writing to its own user: digests, run failures, approval nudges. */
  | 'owner-notification'

export function emailForAudience(identity: ApplicationIdentity, audience: EmailAudience): string {
  switch (audience) {
    case 'employer':
      return identity.email
    case 'auth':
    case 'billing':
    case 'owner-notification':
      // Deliberately NOT `|| identity.email`. If the account has no address,
      // the honest answer is "none" and the caller must handle it — quietly
      // redirecting account mail to an unverified alias is the exact failure
      // this function exists to prevent.
      return identity.accountEmail
  }
}

// --- validating a write -----------------------------------------------------

/** What the settings route accepts. Every field optional; absent means "leave alone" is NOT implied — see validate. */
export interface ApplicationIdentityUpdate {
  email?: string | null
  fullName?: string | null
  phone?: string | null
  location?: string | null
  linkedin?: string | null
  website?: string | null
  /** Explicit human acknowledgement that `email` is an address they can receive mail at. */
  confirm?: boolean
}

export type ApplicationIdentityValidation =
  | { ok: true; settings: ApplicationIdentitySettings }
  | {
      ok: false
      error: string
      /** True when the ONLY thing wrong is a missing confirmation — the UI should ask, not scold. */
      needsConfirmation: boolean
    }

const EDITABLE_STRING_FIELDS = ['email', 'fullName', 'phone', 'location', 'linkedin', 'website'] as const

/**
 * Validate + normalize a settings write.
 *
 * The body is a FULL replacement of the editable fields (an omitted field
 * clears it), which matches a form that always posts every input and avoids
 * the "did they mean to clear it or not send it" ambiguity a partial patch has.
 * `confirmedEmail`/`confirmedAt` are never client-supplied — they are derived
 * here, so a caller cannot mint its own confirmation.
 *
 * @param existing the currently stored settings, so an address already
 *                 confirmed doesn't demand a second confirmation on every save
 * @param accountEmail the account address; an application address equal to it
 *                     needs no confirmation, being the status quo
 * @param now injectable clock for tests
 */
export function validateApplicationIdentityUpdate(
  body: unknown,
  ctx: {
    accountEmail: string | null
    existing: ApplicationIdentitySettings
    now?: () => Date
  }
): ApplicationIdentityValidation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object', needsConfirmation: false }
  }
  const b = body as Record<string, unknown>

  for (const field of EDITABLE_STRING_FIELDS) {
    const value = b[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: `${field} must be a string`, needsConfirmation: false }
    }
  }
  if (b.confirm !== undefined && typeof b.confirm !== 'boolean') {
    return { ok: false, error: 'confirm must be a boolean', needsConfirmation: false }
  }

  const email = str(b.email, MAX_EMAIL_LENGTH)
  const accountEmail = str(ctx.accountEmail, MAX_EMAIL_LENGTH)

  let confirmedEmail: string | null = null
  let confirmedAt: string | null = null

  if (email !== null) {
    if (!looksLikeEmail(email)) {
      // Rejected outright rather than stored-and-flagged. A stored bad address
      // is one refresh away from looking configured and correct.
      return {
        ok: false,
        error: `“${email}” doesn’t look like an email address. Employers reply to this address, so it has to be exact.`,
        needsConfirmation: false,
      }
    }

    if (!sameEmail(email, accountEmail)) {
      const alreadyConfirmed = sameEmail(ctx.existing.confirmedEmail, email)
      if (!alreadyConfirmed && b.confirm !== true) {
        return {
          ok: false,
          error: `Confirm that you can receive mail at ${email} — every interview reply will go there instead of ${
            accountEmail ?? 'your account address'
          }.`,
          needsConfirmation: true,
        }
      }
      confirmedEmail = email
      confirmedAt = alreadyConfirmed
        ? ctx.existing.confirmedAt ?? (ctx.now?.() ?? new Date()).toISOString()
        : (ctx.now?.() ?? new Date()).toISOString()
    }
    // email === accountEmail: nothing to confirm, so confirmedEmail stays null.
    // resolveApplicationIdentity treats "same as account" as confirmed by
    // construction; storing a confirmation here would go stale the moment the
    // account address changed.
  }

  return {
    ok: true,
    settings: {
      email,
      confirmedEmail,
      confirmedAt,
      fullName: str(b.fullName),
      phone: str(b.phone),
      location: str(b.location),
      linkedin: normalizeUrl(b.linkedin),
      website: normalizeUrl(b.website),
    },
  }
}
