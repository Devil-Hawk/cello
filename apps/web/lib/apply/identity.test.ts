// Tests for lib/apply/identity.ts — which address a job application goes out
// under, and which addresses it must never touch.
//
// WHY THIS FILE EXISTS
//   Two failures here are silent and expensive, and neither shows up in a
//   screenshot:
//
//   (1) An application leaves with an address nobody reads. A typo'd or blank
//       address doesn't bounce back to the user — the employer replies into
//       nothing and the user concludes they were rejected. Every fallback rule
//       in resolveApplicationIdentity() exists to make that impossible, so each
//       one is pinned below.
//
//   (2) The application address leaks into account mail. A password reset or an
//       invoice sent to a recruiter-mail alias Cello never verified locks the
//       user out of their own account. emailForAudience() is the rule; the last
//       describe block is the rule in executable form, and any change that
//       loosens it has to delete an assertion that says why it was there.
//
// Pure module, no DB and no network: every case is a preferences blob in, an
// identity out.

import { describe, expect, it } from 'vitest'
import {
  EMPTY_APPLICATION_IDENTITY_SETTINGS,
  emailForAudience,
  readApplicationIdentitySettings,
  resolveApplicationIdentity,
  serializeApplicationIdentity,
  validateApplicationIdentityUpdate,
  type ApplicationIdentitySettings,
} from './identity'

const ACCOUNT = 'ankit.university@campus.edu'
const APPLY_AS = 'ankit.hires@gmail.com'

/** A profiles row with an applicationIdentity blob already saved. */
function rowWith(identity: Record<string, unknown>, accountEmail: string | null = ACCOUNT) {
  return {
    full_name: 'Ankit Punjabi',
    email: accountEmail,
    preferences: { applicationIdentity: identity },
  }
}

/** The stored settings for an address the user confirmed. */
function confirmed(email: string): Record<string, unknown> {
  return { email, confirmedEmail: email, confirmedAt: '2026-08-01T00:00:00.000Z' }
}

describe('resolveApplicationIdentity — precedence', () => {
  it('a confirmed application email wins over the account email', () => {
    const identity = resolveApplicationIdentity(rowWith(confirmed(APPLY_AS)))
    expect(identity.email).toBe(APPLY_AS)
    expect(identity.emailSource).toBe('application')
    expect(identity.usesSeparateEmail).toBe(true)
    expect(identity.accountEmail).toBe(ACCOUNT)
  })

  it('says out loud, as an info notice, where employers will actually reply', () => {
    const identity = resolveApplicationIdentity(rowWith(confirmed(APPLY_AS)))
    const notice = identity.notices.find((n) => n.code === 'separate-application-email')
    expect(notice).toBeDefined()
    expect(notice?.message).toContain(APPLY_AS)
    expect(notice?.message).toContain(ACCOUNT)
  })

  it('confirmation is bound to the exact address, so editing it behind our back un-confirms it', () => {
    // A boolean `confirmed: true` flag would survive this edit and keep
    // claiming an address no human ever read.
    const identity = resolveApplicationIdentity(
      rowWith({ email: 'ankit.hires@gmial.com', confirmedEmail: APPLY_AS, confirmedAt: '2026-08-01T00:00:00.000Z' })
    )
    expect(identity.email).toBe(ACCOUNT)
    expect(identity.notices.map((n) => n.code)).toContain('unconfirmed-application-email')
  })

  it('an application email equal to the account email needs no confirmation and is not "separate"', () => {
    const identity = resolveApplicationIdentity(rowWith({ email: ACCOUNT.toUpperCase() }))
    expect(identity.emailSource).toBe('application')
    expect(identity.usesSeparateEmail).toBe(false)
    expect(identity.notices).toEqual([])
  })

  it('display name, phone, location and links come from the identity when set', () => {
    const identity = resolveApplicationIdentity(
      rowWith({
        ...confirmed(APPLY_AS),
        fullName: 'Ankit P.',
        phone: '+1 555 0100',
        location: 'Seattle, WA',
        linkedin: 'linkedin.com/in/ankit',
        website: 'https://ankit.dev',
      })
    )
    expect(identity.fullName).toBe('Ankit P.')
    expect(identity.phone).toBe('+1 555 0100')
    expect(identity.location).toBe('Seattle, WA')
    // A scheme-less profile URL is a dead link in several ATS fields.
    expect(identity.linkedin).toBe('https://linkedin.com/in/ankit')
    expect(identity.website).toBe('https://ankit.dev')
  })

  it('falls back to profiles.full_name when no display name is configured', () => {
    expect(resolveApplicationIdentity(rowWith(confirmed(APPLY_AS))).fullName).toBe('Ankit Punjabi')
  })
})

describe('resolveApplicationIdentity — fallback: never silently blank', () => {
  it('uses the account email when nothing is configured', () => {
    const identity = resolveApplicationIdentity({ full_name: 'Ankit', email: ACCOUNT, preferences: {} })
    expect(identity.email).toBe(ACCOUNT)
    expect(identity.emailSource).toBe('account')
    expect(identity.usesSeparateEmail).toBe(false)
    expect(identity.notices).toEqual([])
  })

  it('tolerates a null/garbage preferences blob rather than throwing', () => {
    for (const preferences of [null, undefined, 'nope', 42, [], { applicationIdentity: 'nope' }]) {
      const identity = resolveApplicationIdentity({ email: ACCOUNT, preferences })
      expect(identity.email).toBe(ACCOUNT)
    }
  })

  it('holds back an UNCONFIRMED address and keeps applying from the account address', () => {
    const identity = resolveApplicationIdentity(rowWith({ email: APPLY_AS }))
    expect(identity.email).toBe(ACCOUNT)
    expect(identity.emailSource).toBe('account')
    const notice = identity.notices.find((n) => n.code === 'unconfirmed-application-email')
    expect(notice?.severity).toBe('warning')
    expect(notice?.message).toContain(APPLY_AS)
  })

  it('uses an unconfirmed address anyway when there is no account address to fall back to', () => {
    // Here the alternative to an unconfirmed address is not the login address,
    // it is no address at all — which is strictly worse.
    const identity = resolveApplicationIdentity(rowWith({ email: APPLY_AS }, null))
    expect(identity.email).toBe(APPLY_AS)
    expect(identity.emailSource).toBe('application')
    expect(identity.notices.map((n) => n.code)).toContain('unconfirmed-application-email')
  })

  it('reports "no address anywhere" as an error rather than returning a plausible blank', () => {
    const identity = resolveApplicationIdentity({ email: null, preferences: {} })
    expect(identity.email).toBe('')
    expect(identity.emailSource).toBe('none')
    expect(identity.notices[0]).toMatchObject({ code: 'no-account-email', severity: 'error' })
  })
})

describe('resolveApplicationIdentity — invalid addresses are refused, not applied', () => {
  const bad = ['jane', 'jane@', '@example.com', 'jane@localhost', 'jane doe@example.com', 'a@b@example.com']

  it.each(bad)('ignores %s and falls back to the account address', (value) => {
    const identity = resolveApplicationIdentity(rowWith({ ...confirmed(value) }))
    expect(identity.email).toBe(ACCOUNT)
    expect(identity.emailSource).toBe('account')
    const notice = identity.notices.find((n) => n.code === 'invalid-application-email')
    expect(notice?.severity).toBe('error')
  })

  it('an invalid stored address cannot be rescued by a matching confirmation', () => {
    // Confirmation is about "can you receive mail here", not "is this an
    // address" — a confirmed non-address is still a non-address.
    const identity = resolveApplicationIdentity(rowWith(confirmed('not-an-address')))
    expect(identity.usesSeparateEmail).toBe(false)
  })

  it('sorts errors ahead of warnings ahead of info, so the UI can render notices[0] first', () => {
    const identity = resolveApplicationIdentity(rowWith(confirmed('nope'), null))
    expect(identity.notices.map((n) => n.severity)).toEqual(['error', 'error'])
  })
})

describe('readApplicationIdentitySettings — legacy preferences.contact', () => {
  it('inherits the contact details buildApplyProfile already put on forms', () => {
    const settings = readApplicationIdentitySettings({
      contact: {
        phone: '+1 555 0100',
        location: 'Seattle, WA',
        linkedin: 'linkedin.com/in/ankit',
        portfolio: 'ankit.dev',
      },
    })
    expect(settings.phone).toBe('+1 555 0100')
    expect(settings.location).toBe('Seattle, WA')
    expect(settings.linkedin).toBe('https://linkedin.com/in/ankit')
    expect(settings.website).toBe('https://ankit.dev')
  })

  it('does NOT inherit contact.email as an application address', () => {
    // Nothing ever put preferences.contact.email on a form. Promoting it now
    // would start applying under an address the user chose for something else.
    const settings = readApplicationIdentitySettings({ contact: { email: 'owner@example.com' } })
    expect(settings.email).toBeNull()
  })

  it('the new key wins over the legacy one field by field', () => {
    const settings = readApplicationIdentitySettings({
      contact: { phone: 'old', location: 'old' },
      applicationIdentity: { phone: 'new' },
    })
    expect(settings.phone).toBe('new')
    expect(settings.location).toBe('old')
  })

  it('round-trips through serializeApplicationIdentity without inventing or losing a field', () => {
    const settings: ApplicationIdentitySettings = {
      ...EMPTY_APPLICATION_IDENTITY_SETTINGS,
      email: APPLY_AS,
      confirmedEmail: APPLY_AS,
      confirmedAt: '2026-08-01T00:00:00.000Z',
      fullName: 'Ankit P.',
    }
    const stored = serializeApplicationIdentity(settings)
    expect(stored).not.toHaveProperty('phone') // nulls are omitted, not stored
    expect(readApplicationIdentitySettings({ applicationIdentity: stored })).toEqual(settings)
  })
})

describe('validateApplicationIdentityUpdate', () => {
  const ctx = (existing: Partial<ApplicationIdentitySettings> = {}) => ({
    accountEmail: ACCOUNT,
    existing: { ...EMPTY_APPLICATION_IDENTITY_SETTINGS, ...existing },
    now: () => new Date('2026-08-03T12:00:00.000Z'),
  })

  it('refuses a non-object body and wrongly-typed fields', () => {
    expect(validateApplicationIdentityUpdate(null, ctx())).toMatchObject({ ok: false })
    expect(validateApplicationIdentityUpdate([], ctx())).toMatchObject({ ok: false })
    expect(validateApplicationIdentityUpdate({ email: 42 }, ctx())).toMatchObject({ ok: false })
    expect(validateApplicationIdentityUpdate({ confirm: 'yes' }, ctx())).toMatchObject({ ok: false })
  })

  it('refuses to STORE an invalid address at all', () => {
    // Storing it and flagging it later would leave a bad address looking
    // configured and correct one refresh after the warning scrolled away.
    const result = validateApplicationIdentityUpdate({ email: 'ankit.hires@gmial', confirm: true }, ctx())
    expect(result).toMatchObject({ ok: false, needsConfirmation: false })
  })

  it('requires an explicit confirm when the address differs from the account address', () => {
    const result = validateApplicationIdentityUpdate({ email: APPLY_AS }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.needsConfirmation).toBe(true)
    expect(result.error).toContain(APPLY_AS)
  })

  it('stamps the confirmation against the exact address once confirmed', () => {
    const result = validateApplicationIdentityUpdate({ email: APPLY_AS, confirm: true }, ctx())
    expect(result).toMatchObject({
      ok: true,
      settings: {
        email: APPLY_AS,
        confirmedEmail: APPLY_AS,
        confirmedAt: '2026-08-03T12:00:00.000Z',
      },
    })
  })

  it('never lets a client mint its own confirmation for a different address', () => {
    const result = validateApplicationIdentityUpdate(
      { email: APPLY_AS, confirm: true, confirmedEmail: 'attacker@example.com', confirmedAt: '1999-01-01' },
      ctx()
    )
    if (!result.ok) throw new Error('expected ok')
    expect(result.settings.confirmedEmail).toBe(APPLY_AS)
    expect(result.settings.confirmedAt).toBe('2026-08-03T12:00:00.000Z')
  })

  it('does not re-ask for confirmation when saving other fields on an already-confirmed address', () => {
    const result = validateApplicationIdentityUpdate(
      { email: APPLY_AS, phone: '+1 555 0100' },
      ctx({ confirmedEmail: APPLY_AS, confirmedAt: '2026-08-01T00:00:00.000Z' })
    )
    if (!result.ok) throw new Error('expected ok')
    expect(result.settings.phone).toBe('+1 555 0100')
    // The original confirmation timestamp survives — it records when the human
    // actually said yes, not when they last saved a phone number.
    expect(result.settings.confirmedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('needs no confirmation for the account address itself, and stores no confirmation for it', () => {
    const result = validateApplicationIdentityUpdate({ email: ACCOUNT }, ctx())
    if (!result.ok) throw new Error('expected ok')
    expect(result.settings.confirmedEmail).toBeNull()
  })

  it('clearing the address is allowed and means "fall back to the account"', () => {
    const result = validateApplicationIdentityUpdate(
      { email: '   ' },
      ctx({ email: APPLY_AS, confirmedEmail: APPLY_AS })
    )
    if (!result.ok) throw new Error('expected ok')
    expect(result.settings.email).toBeNull()
    expect(result.settings.confirmedEmail).toBeNull()
    expect(resolveApplicationIdentity(rowWith(serializeApplicationIdentity(result.settings))).email).toBe(ACCOUNT)
  })
})

describe('emailForAudience — the application address must never become account mail', () => {
  const identity = resolveApplicationIdentity(rowWith(confirmed(APPLY_AS)))

  it('gives employers the application address', () => {
    expect(identity.email).toBe(APPLY_AS)
    expect(emailForAudience(identity, 'employer')).toBe(APPLY_AS)
  })

  it.each(['auth', 'billing', 'owner-notification'] as const)(
    'gives %s the ACCOUNT address even when a separate application address is in force',
    (audience) => {
      // Sign-in recovery, invoices and "your run failed" all follow the account
      // auth already proved the user controls. A recruiter-mail alias they check
      // weekly is not that, and Cello has never verified it.
      expect(emailForAudience(identity, audience)).toBe(ACCOUNT)
      expect(emailForAudience(identity, audience)).not.toBe(APPLY_AS)
    }
  )

  it('returns nothing — not the application address — when the account has no address', () => {
    const noAccount = resolveApplicationIdentity(rowWith(confirmed(APPLY_AS), null))
    expect(noAccount.email).toBe(APPLY_AS)
    for (const audience of ['auth', 'billing', 'owner-notification'] as const) {
      expect(emailForAudience(noAccount, audience)).toBe('')
    }
  })
})
