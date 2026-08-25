// The Gmail permission model: what used to be one all-or-nothing "connect
// Gmail" OAuth grant (gmail.readonly, requested at login and again on every
// reconnect) is split into independently grantable tiers, stored at
// profiles.preferences.gmail_permissions. Pure, framework-free — safe to
// import from route handlers, the harness, and client components alike.
//
// Design constraints this file encodes (see the audit this shipped against):
//  - A user must be able to grant "send" while refusing "read". Google's
//    OAuth scopes don't offer a narrower "just this thread" read scope, so
//    the "read selected shared threads" tier deliberately requests NO Google
//    scope at all — it works by the user pasting/forwarding a thread in
//    directly (see lib/gmail/share.ts), never by Cello connecting to the
//    mailbox. Only "monitor mailbox" ever requests gmail.readonly.
//  - Each grant requests ONLY the scope it needs, with
//    `include_granted_scopes: true` so Google returns a token covering the
//    union of every scope this user has ever granted this OAuth client —
//    incremental authorization, not one all-or-nothing consent screen.
//  - Existing users who already relied on Gmail sync must not go dark the
//    moment this ships. If they have sync history, "monitor" is carried
//    forward as enabled — but recorded as an explicit, reversible migration,
//    never a silent assumption baked into every read forever.

export type GmailPermissionTier = 'send' | 'readShared' | 'monitor'

export interface GmailPermissionGrant {
  enabled: boolean
  /** ISO 8601. Set on the transition into enabled=true. */
  grantedAt: string | null
  /** ISO 8601. Set on the transition into enabled=false. */
  revokedAt: string | null
  /** Set once, only for a tier carried over from the pre-split single-scope model. */
  migratedFrom: 'legacy_readonly_grant' | null
}

export interface GmailPermissionState {
  send: GmailPermissionGrant
  readShared: GmailPermissionGrant
  monitor: GmailPermissionGrant
}

const EMPTY_GRANT: GmailPermissionGrant = {
  enabled: false,
  grantedAt: null,
  revokedAt: null,
  migratedFrom: null,
}

export const DEFAULT_GMAIL_PERMISSIONS: GmailPermissionState = {
  send: { ...EMPTY_GRANT },
  readShared: { ...EMPTY_GRANT },
  monitor: { ...EMPTY_GRANT },
}

/** The Google OAuth scope each tier needs, or null when it needs none. */
export const GMAIL_PERMISSION_SCOPES: Record<GmailPermissionTier, string | null> = {
  send: 'https://www.googleapis.com/auth/gmail.send',
  readShared: null,
  monitor: 'https://www.googleapis.com/auth/gmail.readonly',
}

/**
 * Pass as `queryParams` alongside a single new scope on
 * `supabase.auth.signInWithOAuth`. `include_granted_scopes` is what makes
 * this incremental rather than replacing: Google returns a token covering
 * every scope this user has ever granted the app, not just the one just
 * requested, so granting "monitor" later doesn't silently drop "send".
 */
export const INCREMENTAL_OAUTH_QUERY_PARAMS = {
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
} as const

export interface GmailPermissionTierMeta {
  id: GmailPermissionTier | 'prepare'
  label: string
  advanced: boolean
  requiresGoogleScope: string | null
  /** Concrete sentences of what Cello can see/do with this permission alone. */
  canSee: string[]
  /** Concrete sentences of what Cello explicitly cannot see/do. */
  cannotSee: string[]
  description: string
  selfHostWarning: string | null
}

export const GMAIL_PERMISSION_TIER_META: Record<GmailPermissionTier | 'prepare', GmailPermissionTierMeta> = {
  prepare: {
    id: 'prepare',
    label: 'Prepare messages',
    advanced: false,
    requiresGoogleScope: null,
    description:
      "Cello drafts outreach and follow-up messages for your review. Sending is up to you, via your own mail client (mailto) or copy/paste.",
    canSee: ['Nothing — no Google sign-in is requested for this tier.'],
    cannotSee: ['Your inbox, sent mail, contacts, or anything else in your Google account.'],
    selfHostWarning: null,
  },
  send: {
    id: 'send',
    label: 'Send approved messages',
    advanced: false,
    requiresGoogleScope: GMAIL_PERMISSION_SCOPES.send,
    description:
      "Cello can send a message you've explicitly approved, from your own Gmail address. It still cannot open your inbox.",
    canSee: [
      "The exact message you approved, sent from your own Gmail account.",
      'Confirmation that Google accepted the send (a message and thread ID).',
    ],
    cannotSee: [
      'Your inbox, sent mail, drafts, or any message you did not approve.',
      'Whether or how the recipient replies — this permission alone gives Cello no visibility into replies.',
    ],
    selfHostWarning: null,
  },
  readShared: {
    id: 'readShared',
    label: 'Read selected shared threads',
    advanced: false,
    requiresGoogleScope: GMAIL_PERMISSION_SCOPES.readShared,
    description:
      'Share one thread at a time by pasting it in — Cello checks it against your tracked applications. No standing mailbox access, no Google read scope requested.',
    canSee: ['The single email thread you paste in: its subject, sender, and body.'],
    cannotSee: [
      'Anything else in your mailbox. Cello never connects to your inbox for this — it only ever sees what you hand it directly.',
    ],
    selfHostWarning: null,
  },
  monitor: {
    id: 'monitor',
    label: 'Monitor mailbox',
    advanced: true,
    requiresGoogleScope: GMAIL_PERMISSION_SCOPES.monitor,
    description:
      'Cello scans your inbox in the background for job-application email and updates your pipeline automatically.',
    canSee: [
      "Every message a Gmail search for application-shaped subjects/senders matches — sender, subject, and body — across your whole mailbox.",
    ],
    cannotSee: [
      "Nothing is walled off within the grant itself: gmail.readonly covers your entire mailbox. Cello only processes messages that match its application-email search, but Google's permission screen does not limit access to those messages.",
    ],
    selfHostWarning:
      "Gmail read scopes are Google-restricted: any OAuth app requesting them must pass Google's CASA security assessment annually. Cello's hosted app has done this. If you self-host Cello, this permission will not work until you register your own Google Cloud OAuth client and complete CASA yourself — a real, recurring cost specific to this tier, not the others.",
  },
}

/** True when `gmail_sync` shows this user actually relied on Gmail sync before. */
function hasLegacySyncHistory(preferences: Record<string, unknown>): { hasSyncHistory: boolean; lastSyncedAt: string | null } {
  const raw = preferences.gmail_sync
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { hasSyncHistory: false, lastSyncedAt: null }
  const gmailSync = raw as Record<string, unknown>
  const lastSyncDate = typeof gmailSync.lastSyncDate === 'string' ? gmailSync.lastSyncDate : null
  const scannedIds = Array.isArray(gmailSync.scannedEmailIds) ? gmailSync.scannedEmailIds : []
  return { hasSyncHistory: Boolean(lastSyncDate) || scannedIds.length > 0, lastSyncedAt: lastSyncDate }
}

function normalizeGrant(value: unknown, fallback: GmailPermissionGrant = EMPTY_GRANT): GmailPermissionGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback }
  const g = value as Record<string, unknown>
  const migratedFrom = g.migratedFrom === 'legacy_readonly_grant' ? 'legacy_readonly_grant' : null
  return {
    enabled: g.enabled === true,
    grantedAt: typeof g.grantedAt === 'string' ? g.grantedAt : null,
    revokedAt: typeof g.revokedAt === 'string' ? g.revokedAt : null,
    migratedFrom,
  }
}

export interface ParsedGmailPermissions {
  state: GmailPermissionState
  /**
   * True when no `gmail_permissions` block was ever stored but legacy sync
   * history implies "monitor" was effectively already granted. Callers that
   * can persist (e.g. the GET /api/gmail/permissions route) should write
   * `state` back so the migration becomes explicit and reversible instead of
   * being re-derived from `gmail_sync` on every read forever.
   */
  needsMigrationPersist: boolean
  legacy: { hasSyncHistory: boolean; lastSyncedAt: string | null }
}

/**
 * Read the permission state out of `profiles.preferences`. Never throws —
 * malformed/missing data resolves to the all-disabled default. `preferences`
 * should be the raw JSON column value (already parsed).
 */
export function parseGmailPermissions(preferences: unknown): ParsedGmailPermissions {
  const prefs = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : {}
  const legacy = hasLegacySyncHistory(prefs)
  const raw = prefs.gmail_permissions

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    const state: GmailPermissionState = {
      send: normalizeGrant(r.send),
      readShared: normalizeGrant(r.readShared),
      monitor: normalizeGrant(r.monitor),
    }
    return { state, needsMigrationPersist: false, legacy }
  }

  if (legacy.hasSyncHistory) {
    const state: GmailPermissionState = {
      send: { ...EMPTY_GRANT },
      readShared: { ...EMPTY_GRANT },
      monitor: {
        enabled: true,
        grantedAt: legacy.lastSyncedAt,
        revokedAt: null,
        migratedFrom: 'legacy_readonly_grant',
      },
    }
    return { state, needsMigrationPersist: true, legacy }
  }

  return { state: { ...DEFAULT_GMAIL_PERMISSIONS }, needsMigrationPersist: false, legacy }
}

/** Convenience: is this one tier enabled, given the raw preferences JSON. */
export function hasGmailPermission(preferences: unknown, tier: GmailPermissionTier): boolean {
  return parseGmailPermissions(preferences).state[tier].enabled
}

/**
 * Read-modify-write helper: apply one tier's enabled/disabled transition and
 * return the FULL next `preferences` object (spreading everything else
 * untouched — `preferences` also holds api_keys, digest, targeting, model,
 * gmail_sync; callers must write this whole object back, never just the
 * `gmail_permissions` key, or every other preference gets wiped).
 */
export function applyGmailPermissionChange(
  preferences: unknown,
  tier: GmailPermissionTier,
  enabled: boolean,
  now: string = new Date().toISOString()
): Record<string, unknown> {
  const prefs = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : {}
  const { state } = parseGmailPermissions(prefs)
  const prevGrant = state[tier]
  const nextGrant: GmailPermissionGrant = enabled
    ? { enabled: true, grantedAt: now, revokedAt: null, migratedFrom: prevGrant.migratedFrom }
    : { enabled: false, grantedAt: prevGrant.grantedAt, revokedAt: now, migratedFrom: prevGrant.migratedFrom }
  const nextState: GmailPermissionState = { ...state, [tier]: nextGrant }
  return { ...prefs, gmail_permissions: nextState }
}

/** Write the full (already-computed) permission state back into `preferences`, untouched otherwise. */
export function withGmailPermissionState(preferences: unknown, state: GmailPermissionState): Record<string, unknown> {
  const prefs = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? (preferences as Record<string, unknown>)
    : {}
  return { ...prefs, gmail_permissions: state }
}

/**
 * Best-effort check of what scopes a live Google access token actually
 * carries, via Google's public tokeninfo endpoint. Used only for UI
 * reconciliation ("Google shows this is already granted — confirm?") — never
 * the source of truth for enforcement, and never throws; a failed/expired
 * token or network error just yields an empty scope list.
 */
export async function fetchGrantedGoogleScopes(accessToken: string): Promise<string[]> {
  if (!accessToken) return []
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    )
    if (!res.ok) return []
    const data = (await res.json()) as { scope?: string }
    return typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : []
  } catch {
    return []
  }
}

/** Whether a live token's granted-scope list already covers a tier's requirement. */
export function liveScopesCoverTier(liveScopes: string[], tier: GmailPermissionTier): boolean {
  const required = GMAIL_PERMISSION_SCOPES[tier]
  if (!required) return true // no Google scope needed for this tier
  return liveScopes.includes(required)
}
