// Ported from packages/agents/src/network/network.test.ts's "Contact Matcher
// Module", "Connection Strength Module" and "Referral Paths Module" suites
// (the pure-function tests that pin THIS module's actual matching/scoring/
// ranking behavior) plus a smaller replacement for "NetworkAgent class" /
// "analyzeCompany method", now exercised through the plain analyzeNetwork()
// function instead of an Agent-class instance. NOT ported: matchContactsByDomain
// /matchContactsByName tests — those functions were superseded by
// matchContactToCompany even in the original agent (see network.ts's header)
// and were never ported.

import { describe, expect, it } from 'vitest'
import {
  analyzeNetwork,
  calculateConnectionStrength,
  calculateDaysSinceContact,
  calculatePathStrength,
  findReferralPaths,
  getRecencyMultiplier,
  getRelationshipType,
  matchContactToCompany,
  normalizeCompanyName,
  rankReferralPaths,
  resolveCompanyAliases,
  selectBestPath,
  type ContactNode,
  type NetworkAnalysisInput,
  type ReferralPath,
} from './network'

describe('normalizeCompanyName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCompanyName('  Google  ')).toBe('google')
    expect(normalizeCompanyName('FACEBOOK')).toBe('facebook')
  })

  it('removes common suffixes', () => {
    expect(normalizeCompanyName('Google Inc.')).toBe('google')
    expect(normalizeCompanyName('Meta LLC')).toBe('meta')
    expect(normalizeCompanyName('Stripe Corporation')).toBe('stripe')
  })

  it('handles special characters', () => {
    expect(normalizeCompanyName('Meta (Facebook)')).toBe('meta facebook')
  })
})

describe('resolveCompanyAliases', () => {
  it('resolves known aliases both directions', () => {
    expect(resolveCompanyAliases('google')).toContain('alphabet')
    expect(resolveCompanyAliases('facebook')).toContain('meta')
  })

  it('returns just the normalized name when no alias exists', () => {
    const aliases = resolveCompanyAliases('unknowncompany')
    expect(aliases).toEqual(['unknowncompany'])
  })
})

describe('matchContactToCompany', () => {
  const input: NetworkAnalysisInput = { companyId: 'c1', companyName: 'Google', companyDomain: 'google.com' }

  it('matches by domain first', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@google.com', companyName: 'Microsoft' }
    const result = matchContactToCompany(contact, input)
    expect(result?.matchType).toBe('domain')
  })

  it('matches by name when the domain does not match', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@personal.com', companyName: 'Google' }
    const result = matchContactToCompany(contact, input)
    expect(result?.matchType).toBe('name')
  })

  it('matches by alias', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@alphabet.com', companyName: 'Alphabet' }
    expect(matchContactToCompany(contact, input)).not.toBeNull()
  })

  it('returns null for a non-matching contact', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@stripe.com', companyName: 'Stripe' }
    expect(matchContactToCompany(contact, input)).toBeNull()
  })

  it('never matches on a personal email domain, even against a company with no other match', () => {
    // gmail.com can never be a legitimate employer domain — isPersonalEmailDomain
    // must reject it before it ever reaches the domain==target comparison.
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@gmail.com', companyName: 'Some Other Co' }
    expect(matchContactToCompany(contact, input)).toBeNull()
  })

  it('falls through to a name match when the email is a personal domain but the company name matches', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@gmail.com', companyName: 'Google' }
    const result = matchContactToCompany(contact, input)
    expect(result?.matchType).toBe('name')
  })

  it('matches by name when the contact has no email at all', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', companyName: 'Google' }
    const result = matchContactToCompany(contact, input)
    expect(result?.matchType).toBe('name')
  })

  it('matches by name when the contact email has no @ (no domain to extract)', () => {
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'not-an-email', companyName: 'Google' }
    const result = matchContactToCompany(contact, input)
    expect(result?.matchType).toBe('name')
  })

  it('still matches by alias-derived domain when the input has no companyDomain on file', () => {
    const inputNoDomain: NetworkAnalysisInput = { companyId: 'c1', companyName: 'Google' }
    const contact: ContactNode = { id: '1', name: 'Alice', email: 'alice@google.com', companyName: 'Microsoft' }
    const result = matchContactToCompany(contact, inputNoDomain)
    expect(result?.matchType).toBe('domain')
  })

  it('returns null when neither the contact nor the input has any domain, and names differ', () => {
    const inputNoDomain: NetworkAnalysisInput = { companyId: 'c1', companyName: 'Google' }
    const contact: ContactNode = { id: '1', name: 'Alice', companyName: 'Stripe' }
    expect(matchContactToCompany(contact, inputNoDomain)).toBeNull()
  })
})

describe('getRelationshipType', () => {
  it('parses known relationship types', () => {
    expect(getRelationshipType('former_colleague')).toBe('former_colleague')
    expect(getRelationshipType('alumni')).toBe('alumni')
    expect(getRelationshipType('direct_contact')).toBe('direct_contact')
  })

  it('falls back to unknown for unrecognized or missing relationships', () => {
    expect(getRelationshipType('some random text')).toBe('unknown')
    expect(getRelationshipType(null)).toBe('unknown')
    expect(getRelationshipType(undefined)).toBe('unknown')
  })

  it('is case insensitive', () => {
    expect(getRelationshipType('FORMER_COLLEAGUE')).toBe('former_colleague')
  })
})

describe('calculateDaysSinceContact', () => {
  it('calculates days since last contact', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const days = calculateDaysSinceContact(tenDaysAgo)
    expect(days).toBeGreaterThanOrEqual(9)
    expect(days).toBeLessThanOrEqual(11)
  })

  it('returns undefined with no date on file', () => {
    expect(calculateDaysSinceContact(null)).toBeUndefined()
    expect(calculateDaysSinceContact(undefined)).toBeUndefined()
  })
})

describe('getRecencyMultiplier', () => {
  it('rewards very recent contact', () => {
    expect(getRecencyMultiplier(0)).toBe(1.2)
    expect(getRecencyMultiplier(7)).toBe(1.2)
  })

  it('degrades through the recency bands', () => {
    expect(getRecencyMultiplier(15)).toBe(1.1)
    expect(getRecencyMultiplier(60)).toBe(1.0)
    expect(getRecencyMultiplier(180)).toBe(0.8)
  })

  it('defaults to neutral when unknown', () => {
    expect(getRecencyMultiplier(undefined)).toBe(1.0)
  })
})

describe('calculateConnectionStrength', () => {
  it('scores a recent direct contact near the top', () => {
    const strength = calculateConnectionStrength('direct_contact', 5)
    expect(strength).toBeLessThanOrEqual(1.0)
    expect(strength).toBeGreaterThan(0.9)
  })

  it('applies the recent-contact bonus', () => {
    expect(calculateConnectionStrength('former_colleague', 15)).toBe(1.0) // 0.8*1.1 + 0.2, capped
  })

  it('scores a stale weak connection low', () => {
    expect(calculateConnectionStrength('linkedin_connection', 120)).toBeCloseTo(0.24, 1)
  })

  it('caps strength at 1.0', () => {
    expect(calculateConnectionStrength('direct_contact', 1)).toBeLessThanOrEqual(1.0)
  })
})

describe('findReferralPaths / calculatePathStrength / rankReferralPaths / selectBestPath', () => {
  const contacts: ContactNode[] = [
    { id: '1', name: 'Alice', relationship: 'direct_contact', lastContactAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    {
      id: '2',
      name: 'Bob',
      relationship: 'former_colleague',
      lastContactAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      connections: ['3'],
    },
    { id: '3', name: 'Carol', relationship: 'second_degree', lastContactAt: null },
  ]

  it('finds a direct referral path for a single contact', () => {
    const paths = findReferralPaths(contacts.slice(0, 1))
    expect(paths[0].steps[0].action).toBe('direct_referral')
  })

  it('finds a two-hop introduction path through a connection', () => {
    const paths = findReferralPaths(contacts)
    expect(paths.some((p) => p.steps.some((s) => s.action === 'introduction'))).toBe(true)
  })

  it('returns nothing for no contacts', () => {
    expect(findReferralPaths([])).toEqual([])
  })

  it('reduces path strength for longer paths (stale dates, no recency bonus)', () => {
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    const staleContacts: ContactNode[] = [
      { id: '1', name: 'Alice', relationship: 'alumni', lastContactAt: staleDate },
      { id: '2', name: 'Bob', relationship: 'alumni', lastContactAt: staleDate },
    ]
    const shortPath: ReferralPath = {
      steps: [{ contactId: '1', contactName: 'Alice', relationship: 'alumni', action: 'direct_referral' }],
      totalStrength: 0,
    }
    const longPath: ReferralPath = {
      steps: [
        { contactId: '1', contactName: 'Alice', relationship: 'alumni', action: 'direct_referral' },
        { contactId: '2', contactName: 'Bob', relationship: 'alumni', action: 'introduction' },
      ],
      totalStrength: 0,
    }
    expect(calculatePathStrength(shortPath, staleContacts)).toBeGreaterThan(calculatePathStrength(longPath, staleContacts))
  })

  it('ranks and selects the strongest path', () => {
    const paths: ReferralPath[] = [
      { steps: [], totalStrength: 0.5 },
      { steps: [], totalStrength: 0.9 },
      { steps: [], totalStrength: 0.3 },
    ]
    expect(rankReferralPaths(paths).map((p) => p.totalStrength)).toEqual([0.9, 0.5, 0.3])
    expect(selectBestPath(paths)?.totalStrength).toBe(0.9)
    expect(selectBestPath([])).toBeUndefined()
  })
})

describe('analyzeNetwork', () => {
  const input: NetworkAnalysisInput = { companyId: 'company-1', companyName: 'Google', companyDomain: 'google.com' }
  const contacts: ContactNode[] = [
    { id: 'c1', name: 'Alice', companyId: 'company-1', relationship: 'former_colleague', lastContactAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
    { id: 'c2', name: 'Bob', companyId: 'company-1', relationship: 'direct_contact', lastContactAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) },
    { id: 'c3', name: 'Carol', companyId: 'company-2', relationship: 'alumni', lastContactAt: null },
  ]

  it('finds only the contacts that match the target company', () => {
    const result = analyzeNetwork(input, contacts)
    expect(result.companyId).toBe('company-1')
    expect(result.contacts.map((c) => c.name).sort()).toEqual(['Alice', 'Bob'])
  })

  it('sorts contacts by connection strength, strongest first', () => {
    const result = analyzeNetwork(input, contacts)
    for (let i = 1; i < result.contacts.length; i++) {
      expect(result.contacts[i - 1].connectionStrength).toBeGreaterThanOrEqual(result.contacts[i].connectionStrength)
    }
  })

  it('returns empty contacts/paths and no bestPath when nothing matches', () => {
    const result = analyzeNetwork(input, [contacts[2]])
    expect(result).toEqual({ companyId: 'company-1', contacts: [], referralPaths: [] })
  })
})
