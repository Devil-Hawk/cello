// Tests for lib/gmail/permissions.ts — the split of one all-or-nothing Gmail
// grant into independently grantable tiers, plus the legacy-user migration
// path and the incremental-OAuth scope bookkeeping.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GMAIL_PERMISSIONS,
  GMAIL_PERMISSION_SCOPES,
  GMAIL_PERMISSION_TIER_META,
  applyGmailPermissionChange,
  fetchGrantedGoogleScopes,
  hasGmailPermission,
  liveScopesCoverTier,
  parseGmailPermissions,
  withGmailPermissionState,
} from './permissions'

describe('parseGmailPermissions — no prior state', () => {
  it('defaults every tier to disabled when preferences is empty', () => {
    const { state, needsMigrationPersist, legacy } = parseGmailPermissions({})
    expect(state).toEqual(DEFAULT_GMAIL_PERMISSIONS)
    expect(needsMigrationPersist).toBe(false)
    expect(legacy.hasSyncHistory).toBe(false)
  })

  it('defaults every tier to disabled when preferences is null/undefined/non-object', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const { state } = parseGmailPermissions(bad)
      expect(state).toEqual(DEFAULT_GMAIL_PERMISSIONS)
    }
  })
})

describe('parseGmailPermissions — legacy migration', () => {
  it('carries "monitor" forward as enabled when gmail_sync shows real sync history (lastSyncDate)', () => {
    const prefs = { gmail_sync: { lastSyncDate: '2026-01-01T00:00:00.000Z', scannedEmailIds: ['a', 'b'] } }
    const { state, needsMigrationPersist, legacy } = parseGmailPermissions(prefs)
    expect(state.monitor.enabled).toBe(true)
    expect(state.monitor.migratedFrom).toBe('legacy_readonly_grant')
    expect(state.monitor.grantedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(state.send.enabled).toBe(false)
    expect(state.readShared.enabled).toBe(false)
    expect(needsMigrationPersist).toBe(true)
    expect(legacy.hasSyncHistory).toBe(true)
    expect(legacy.lastSyncedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('also migrates when only scannedEmailIds is present (no lastSyncDate yet)', () => {
    const prefs = { gmail_sync: { scannedEmailIds: ['a'] } }
    const { state, needsMigrationPersist } = parseGmailPermissions(prefs)
    expect(state.monitor.enabled).toBe(true)
    expect(needsMigrationPersist).toBe(true)
  })

  it('does NOT migrate for a user with an empty/never-run gmail_sync object', () => {
    const prefs = { gmail_sync: { scannedEmailIds: [] } }
    const { state, needsMigrationPersist, legacy } = parseGmailPermissions(prefs)
    expect(state.monitor.enabled).toBe(false)
    expect(needsMigrationPersist).toBe(false)
    expect(legacy.hasSyncHistory).toBe(false)
  })

  it('does not touch send/readShared during migration — only monitor is implied by legacy sync history', () => {
    const prefs = { gmail_sync: { lastSyncDate: '2026-01-01T00:00:00.000Z' } }
    const { state } = parseGmailPermissions(prefs)
    expect(state.send).toEqual(DEFAULT_GMAIL_PERMISSIONS.send)
    expect(state.readShared).toEqual(DEFAULT_GMAIL_PERMISSIONS.readShared)
  })

  it('an explicit stored gmail_permissions block always wins over legacy inference, even if it says disabled', () => {
    const prefs = {
      gmail_sync: { lastSyncDate: '2026-01-01T00:00:00.000Z' },
      gmail_permissions: {
        monitor: { enabled: false, grantedAt: '2026-01-01T00:00:00.000Z', revokedAt: '2026-02-01T00:00:00.000Z', migratedFrom: 'legacy_readonly_grant' },
      },
    }
    const { state, needsMigrationPersist } = parseGmailPermissions(prefs)
    expect(state.monitor.enabled).toBe(false) // user explicitly turned it back off — must stay off
    expect(needsMigrationPersist).toBe(false) // already persisted, never re-migrate
  })

  it('preserves an explicitly stored gmail_permissions block untouched (round-trips send/readShared too)', () => {
    const prefs = {
      gmail_permissions: {
        send: { enabled: true, grantedAt: '2026-01-01T00:00:00.000Z', revokedAt: null, migratedFrom: null },
        readShared: { enabled: true, grantedAt: '2026-01-02T00:00:00.000Z', revokedAt: null, migratedFrom: null },
        monitor: { enabled: false, grantedAt: null, revokedAt: null, migratedFrom: null },
      },
    }
    const { state } = parseGmailPermissions(prefs)
    expect(state.send.enabled).toBe(true)
    expect(state.readShared.enabled).toBe(true)
    expect(state.monitor.enabled).toBe(false)
  })

  it('tolerates a malformed gmail_permissions block (missing tiers, wrong types) without throwing', () => {
    const prefs = { gmail_permissions: { send: 'nonsense', monitor: 42 } }
    expect(() => parseGmailPermissions(prefs)).not.toThrow()
    const { state } = parseGmailPermissions(prefs)
    expect(state.send.enabled).toBe(false)
    expect(state.monitor.enabled).toBe(false)
    expect(state.readShared).toEqual(DEFAULT_GMAIL_PERMISSIONS.readShared)
  })
})

describe('hasGmailPermission', () => {
  it('reflects a granted tier', () => {
    const prefs = { gmail_permissions: { send: { enabled: true, grantedAt: 'x', revokedAt: null, migratedFrom: null } } }
    expect(hasGmailPermission(prefs, 'send')).toBe(true)
    expect(hasGmailPermission(prefs, 'monitor')).toBe(false)
  })

  it('a legacy user has monitor available immediately, without any explicit persistence step', () => {
    const prefs = { gmail_sync: { lastSyncDate: '2026-01-01T00:00:00.000Z' } }
    expect(hasGmailPermission(prefs, 'monitor')).toBe(true)
  })
})

describe('applyGmailPermissionChange', () => {
  it('enabling a tier sets grantedAt to `now` and clears revokedAt', () => {
    const next = applyGmailPermissionChange({}, 'send', true, '2026-03-01T00:00:00.000Z')
    const state = (next.gmail_permissions as any)
    expect(state.send).toEqual({ enabled: true, grantedAt: '2026-03-01T00:00:00.000Z', revokedAt: null, migratedFrom: null })
  })

  it('disabling a tier sets revokedAt and preserves the original grantedAt', () => {
    const granted = applyGmailPermissionChange({}, 'monitor', true, '2026-01-01T00:00:00.000Z')
    const revoked = applyGmailPermissionChange(granted, 'monitor', false, '2026-02-01T00:00:00.000Z')
    const state = (revoked.gmail_permissions as any)
    expect(state.monitor).toEqual({
      enabled: false,
      grantedAt: '2026-01-01T00:00:00.000Z',
      revokedAt: '2026-02-01T00:00:00.000Z',
      migratedFrom: null,
    })
  })

  it('toggling one tier off does not disturb another already-enabled tier (independence)', () => {
    let prefs: unknown = applyGmailPermissionChange({}, 'send', true, '2026-01-01T00:00:00.000Z')
    prefs = applyGmailPermissionChange(prefs, 'monitor', true, '2026-01-02T00:00:00.000Z')
    prefs = applyGmailPermissionChange(prefs, 'send', false, '2026-01-03T00:00:00.000Z')
    const state = (prefs as any).gmail_permissions
    expect(state.send.enabled).toBe(false)
    expect(state.monitor.enabled).toBe(true)
  })

  it('is read-modify-write: unrelated preference keys (api_keys, digest, targeting) survive untouched', () => {
    const prefs = { api_keys: { openrouter: 'secret' }, digest: { enabled: true }, targeting: { minScore: 50 } }
    const next = applyGmailPermissionChange(prefs, 'send', true)
    expect(next.api_keys).toEqual({ openrouter: 'secret' })
    expect(next.digest).toEqual({ enabled: true })
    expect(next.targeting).toEqual({ minScore: 50 })
    expect(next.gmail_permissions).toBeDefined()
  })

  it('re-enabling a previously revoked tier preserves migratedFrom provenance', () => {
    const migratedPrefs = { gmail_sync: { lastSyncDate: '2025-01-01T00:00:00.000Z' } }
    const { state } = parseGmailPermissions(migratedPrefs)
    const persisted = withGmailPermissionState(migratedPrefs, state)
    const revoked = applyGmailPermissionChange(persisted, 'monitor', false, '2026-01-01T00:00:00.000Z')
    const reEnabled = applyGmailPermissionChange(revoked, 'monitor', true, '2026-02-01T00:00:00.000Z')
    expect((reEnabled.gmail_permissions as any).monitor.migratedFrom).toBe('legacy_readonly_grant')
  })
})

describe('withGmailPermissionState', () => {
  it('writes the full state and preserves other preference keys', () => {
    const prefs = { model: 'gpt-5' }
    const next = withGmailPermissionState(prefs, DEFAULT_GMAIL_PERMISSIONS)
    expect(next.model).toBe('gpt-5')
    expect(next.gmail_permissions).toEqual(DEFAULT_GMAIL_PERMISSIONS)
  })
})

describe('scope constants', () => {
  it('send and monitor request distinct, narrow Google scopes', () => {
    expect(GMAIL_PERMISSION_SCOPES.send).toBe('https://www.googleapis.com/auth/gmail.send')
    expect(GMAIL_PERMISSION_SCOPES.monitor).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(GMAIL_PERMISSION_SCOPES.send).not.toBe(GMAIL_PERMISSION_SCOPES.monitor)
  })

  it('readShared requests NO Google scope at all', () => {
    expect(GMAIL_PERMISSION_SCOPES.readShared).toBeNull()
  })

  it('every tier (incl. prepare) has non-empty canSee/cannotSee copy — no placeholder "we respect your privacy" text', () => {
    for (const meta of Object.values(GMAIL_PERMISSION_TIER_META)) {
      expect(meta.canSee.length).toBeGreaterThan(0)
      expect(meta.cannotSee.length).toBeGreaterThan(0)
      for (const sentence of [...meta.canSee, ...meta.cannotSee]) {
        expect(sentence.toLowerCase()).not.toContain('we respect your privacy')
      }
    }
  })

  it('only "monitor" is marked advanced and only it carries a self-host CASA warning', () => {
    expect(GMAIL_PERMISSION_TIER_META.monitor.advanced).toBe(true)
    expect(GMAIL_PERMISSION_TIER_META.monitor.selfHostWarning).toMatch(/CASA/)
    for (const id of ['prepare', 'send', 'readShared'] as const) {
      expect(GMAIL_PERMISSION_TIER_META[id].advanced).toBe(false)
      expect(GMAIL_PERMISSION_TIER_META[id].selfHostWarning).toBeNull()
    }
  })
})

describe('liveScopesCoverTier', () => {
  it('a tier requiring no Google scope is always covered', () => {
    expect(liveScopesCoverTier([], 'readShared')).toBe(true)
  })

  it('checks the live scope list for the exact required scope', () => {
    expect(liveScopesCoverTier(['https://www.googleapis.com/auth/gmail.send'], 'send')).toBe(true)
    expect(liveScopesCoverTier(['https://www.googleapis.com/auth/gmail.send'], 'monitor')).toBe(false)
  })
})

describe('fetchGrantedGoogleScopes', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns [] for an empty token without calling fetch', async () => {
    const spy = vi.fn()
    global.fetch = spy as unknown as typeof fetch
    expect(await fetchGrantedGoogleScopes('')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('parses the space-delimited scope string from a successful tokeninfo response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email' }),
    }) as unknown as typeof fetch
    const scopes = await fetchGrantedGoogleScopes('live-token')
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ])
  })

  it('returns [] (never throws) when the token is invalid/expired', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch
    expect(await fetchGrantedGoogleScopes('bad-token')).toEqual([])
  })

  it('returns [] (never throws) on a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    expect(await fetchGrantedGoogleScopes('token')).toEqual([])
  })
})
