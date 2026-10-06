// What mail is believed, by code: the fixture mailbox replayed through trust, the status patterns and
// the contact kind, plus the attacks that matter: a display name equal to the employer with DKIM
// failing, a relay posing as the employer, a ticket-draw "application".

import { describe, expect, it } from 'vitest'
import { contactKind } from '@/lib/contacts/kind'
import { excerptOf } from './messages'
import { loadMailbox, replay } from './replay'
import { headerVerdict, senderEmployerDomain, trustOf } from './trust'

describe('the mailbox fixture', () => {
  const r = replay(loadMailbox())

  it('reaches every conclusion the fixture carries', () => {
    expect(r.mismatches).toEqual([])
    expect(r.mails).toBe(12)
  })

  it('calls nothing proven that is not, and nothing proven for an employer the sender is not', () => {
    expect(r.precision).toBe(1)
    expect(r.wrongEmployers).toBe(0)
    expect(r.recall).toBe(1)
  })
})

describe('trust', () => {
  const pass = (d: string) => [{ name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.d=${d}` }]

  it('proves mail only from the employer own domain with a passing DKIM for it', () => {
    expect(trustOf({ fromDomain: 'acme.com', employerDomain: 'acme.com', verdict: headerVerdict(pass('acme.com'), 'acme.com') })).toBe('proven')
    expect(trustOf({ fromDomain: 'mail.acme.com', employerDomain: 'acme.com', verdict: headerVerdict(pass('acme.com'), 'mail.acme.com') })).toBe('proven')
  })

  it('does not trust a display name: the right name from the wrong domain with DKIM failing', () => {
    const fail = [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=fail header.d=acme-careers.example' }]
    expect(trustOf({ fromDomain: 'acme-careers.example', employerDomain: 'acme.com', verdict: headerVerdict(fail, 'acme-careers.example') })).toBe('unconfirmed')
    // even with a passing signature, a lookalike domain is not the employer
    expect(trustOf({ fromDomain: 'acme-careers.example', employerDomain: 'acme.com', verdict: headerVerdict(pass('acme-careers.example'), 'acme-careers.example') })).toBe('unconfirmed')
  })

  it('does not trust a domain that only ends like the employer', () => {
    expect(trustOf({ fromDomain: 'notacme.com', employerDomain: 'acme.com', verdict: headerVerdict(pass('notacme.com'), 'notacme.com') })).toBe('unconfirmed')
  })

  it('never takes a relay or a free-mail host for the employer', () => {
    for (const d of ['us.greenhouse-mail.io', 'hire.lever.co', 'mail.greenhouse.io', 'linkedin.com', 'gmail.com']) expect(senderEmployerDomain(d), d).toBeNull()
    expect(senderEmployerDomain('acme.com')).toBe('acme.com')
  })

  it('reads the DKIM result that lines up with the From domain among several', () => {
    const headers = [
      { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=sender.example; dkim=pass header.d=acme.com' },
    ]
    expect(headerVerdict(headers, 'acme.com')).toEqual({ domain: 'acme.com', dkim: 'pass' })
    expect(headerVerdict([], 'acme.com')).toEqual({ domain: null, dkim: 'none' })
  })
})

describe('contact kind', () => {
  it('tells an agency from the employer and a referral from a recruiter', () => {
    const k = (displayName: string, address: string, body: string, subject = 'Hello') => contactKind({ displayName, address, subject, body }).kind
    expect(k('Jo', 'jo@talentpartners.example', 'We are Talent Partners, a search firm.')).toBe('agency_recruiter')
    expect(k('Riley', 'riley@acme.com', "I'm a technical recruiter at Acme.")).toBe('recruiter')
    expect(k('Casey', 'casey@acme.com', 'I can refer you to the team.')).toBe('referrer')
    expect(k('Sam', 'sam@acme.com', 'Your invoice is attached.')).toBe('other')
  })
})

describe('excerpt', () => {
  it('keeps the first six lines, drops quoted replies and caps at 600 characters', () => {
    const body = ['> quoted', ...Array.from({ length: 10 }, (_, i) => `line ${i} ${'x'.repeat(200)}`)].join('\n')
    const e = excerptOf(body)
    expect(e.length).toBeLessThanOrEqual(600)
    expect(e.startsWith('line 0')).toBe(true)
    expect(e.split('\n').length).toBeLessThanOrEqual(6)
  })
})
