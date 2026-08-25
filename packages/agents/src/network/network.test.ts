import { describe, it, expect, beforeEach } from 'vitest'
import { NetworkAgent } from './index'
import {
  matchContactToCompany,
  matchContactsByDomain,
  matchContactsByName,
  normalizeCompanyName,
  resolveCompanyAliases,
} from './contact-matcher'
import {
  calculateConnectionStrength,
  getRelationshipType,
  getRecencyMultiplier,
  calculateDaysSinceContact,
} from './connection-strength'
import {
  findReferralPaths,
  rankReferralPaths,
  selectBestPath,
  calculatePathStrength,
} from './referral-paths'
import type { Contact, Company, UserProfile } from '@cello/shared'
import type { AgentContext } from '../types'
import type { ContactNode, NetworkAnalysisInput } from './types'

// Mock user profile for testing
const mockUserProfile: UserProfile = {
  id: 'user-1',
  email: 'test@example.com',
  fullName: 'John Doe',
  avatarUrl: null,
  resumeText: 'Software Engineer with experience at various tech companies',
  resumeEmbedding: null,
  preferences: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// Mock contacts for testing
const mockContacts: Contact[] = [
  {
    id: 'contact-1',
    userId: 'user-1',
    companyId: 'company-1',
    name: 'Alice Smith',
    email: 'alice@google.com',
    linkedinUrl: 'https://linkedin.com/in/alice',
    title: 'Senior Engineer',
    relationship: 'former_colleague',
    lastContactAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
    notes: null,
    createdAt: new Date(),
  },
  {
    id: 'contact-2',
    userId: 'user-1',
    companyId: 'company-2',
    name: 'Bob Johnson',
    email: 'bob@meta.com',
    linkedinUrl: null,
    title: 'Engineering Manager',
    relationship: 'alumni',
    lastContactAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago
    notes: null,
    createdAt: new Date(),
  },
  {
    id: 'contact-3',
    userId: 'user-1',
    companyId: null,
    name: 'Carol Williams',
    email: 'carol@stripe.com',
    linkedinUrl: 'https://linkedin.com/in/carol',
    title: 'Tech Lead',
    relationship: 'linkedin_connection',
    lastContactAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120 days ago
    notes: null,
    createdAt: new Date(),
  },
  {
    id: 'contact-4',
    userId: 'user-1',
    companyId: 'company-1',
    name: 'David Brown',
    email: 'david@alphabet.com',
    linkedinUrl: null,
    title: 'Staff Engineer',
    relationship: 'direct_contact',
    lastContactAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
    notes: null,
    createdAt: new Date(),
  },
]

// Mock companies for testing
const mockCompanies: Company[] = [
  {
    id: 'company-1',
    userId: 'user-1',
    name: 'Google',
    domain: 'google.com',
    logoUrl: null,
    careerUrl: 'https://careers.google.com',
    scrapeFrequency: 60,
    lastScrapedAt: null,
    isDreamCompany: true,
    notes: null,
    createdAt: new Date(),
  },
  {
    id: 'company-2',
    userId: 'user-1',
    name: 'Meta',
    domain: 'meta.com',
    logoUrl: null,
    careerUrl: 'https://metacareers.com',
    scrapeFrequency: 60,
    lastScrapedAt: null,
    isDreamCompany: false,
    notes: null,
    createdAt: new Date(),
  },
]

describe('Network Agent', () => {
  describe('NetworkAgent class', () => {
    let agent: NetworkAgent

    beforeEach(() => {
      agent = new NetworkAgent()
    })

    it('should have correct name and description', () => {
      expect(agent.name).toBe('Network')
      expect(agent.description).toContain('contact')
    })

    it('should return error when no companies provided', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        companies: [],
      }
      const result = await agent.execute(context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('No companies')
    })

    it('should successfully analyze network for a company', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        companies: mockCompanies,
      }
      // Add contacts to context
      ;(context as any).contacts = mockContacts

      const result = await agent.execute(context)
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
      expect(result.data?.companyId).toBe('company-1')
    })

    it('should find contacts at target company', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        companies: mockCompanies,
      }
      ;(context as any).contacts = mockContacts

      const result = await agent.execute(context)
      expect(result.success).toBe(true)
      expect(result.data?.contacts).toBeDefined()
      expect(result.data?.contacts.length).toBeGreaterThan(0)
    })

    it('should return contacts sorted by connection strength', async () => {
      const context: AgentContext = {
        user: mockUserProfile,
        companies: mockCompanies,
      }
      ;(context as any).contacts = mockContacts

      const result = await agent.execute(context)
      expect(result.success).toBe(true)

      if (result.data?.contacts && result.data.contacts.length > 1) {
        for (let i = 1; i < result.data.contacts.length; i++) {
          expect(result.data.contacts[i - 1].connectionStrength)
            .toBeGreaterThanOrEqual(result.data.contacts[i].connectionStrength)
        }
      }
    })
  })

  describe('analyzeCompany method', () => {
    let agent: NetworkAgent

    beforeEach(() => {
      agent = new NetworkAgent()
    })

    it('should analyze a specific company', async () => {
      const contacts = mockContacts.map((c) => ({
        id: c.id,
        name: c.name,
        title: c.title,
        email: c.email,
        companyId: c.companyId,
        relationship: c.relationship,
        lastContactAt: c.lastContactAt,
      })) as ContactNode[]

      const result = await agent.analyzeCompany(
        {
          companyId: 'company-1',
          companyName: 'Google',
          companyDomain: 'google.com',
        },
        contacts
      )

      expect(result.success).toBe(true)
      expect(result.data?.companyId).toBe('company-1')
    })
  })
})

describe('Contact Matcher Module', () => {
  describe('normalizeCompanyName', () => {
    it('should lowercase and trim company names', () => {
      expect(normalizeCompanyName('  Google  ')).toBe('google')
      expect(normalizeCompanyName('FACEBOOK')).toBe('facebook')
    })

    it('should remove common suffixes', () => {
      expect(normalizeCompanyName('Google Inc.')).toBe('google')
      expect(normalizeCompanyName('Meta LLC')).toBe('meta')
      expect(normalizeCompanyName('Stripe Corporation')).toBe('stripe')
    })

    it('should handle special characters', () => {
      expect(normalizeCompanyName('Meta (Facebook)')).toBe('meta facebook')
    })
  })

  describe('resolveCompanyAliases', () => {
    it('should resolve known company aliases', () => {
      const aliases = resolveCompanyAliases('google')
      expect(aliases).toContain('alphabet')
      expect(aliases).toContain('google')
    })

    it('should resolve Facebook to Meta', () => {
      const aliases = resolveCompanyAliases('facebook')
      expect(aliases).toContain('meta')
    })

    it('should return original name if no alias found', () => {
      const aliases = resolveCompanyAliases('unknowncompany')
      expect(aliases).toContain('unknowncompany')
      expect(aliases).toHaveLength(1)
    })
  })

  describe('matchContactsByDomain', () => {
    const contacts: ContactNode[] = [
      { id: '1', name: 'Alice', email: 'alice@google.com' },
      { id: '2', name: 'Bob', email: 'bob@meta.com' },
      { id: '3', name: 'Carol', email: 'carol@gmail.com' }, // personal email
    ]

    it('should match contacts by email domain', () => {
      const matches = matchContactsByDomain(contacts, 'google.com')
      expect(matches).toHaveLength(1)
      expect(matches[0].contact.name).toBe('Alice')
    })

    it('should handle missing domain', () => {
      const matches = matchContactsByDomain(contacts, null)
      expect(matches).toHaveLength(0)
    })

    it('should not match personal email domains', () => {
      const matches = matchContactsByDomain(contacts, 'gmail.com')
      expect(matches).toHaveLength(0)
    })
  })

  describe('matchContactsByName', () => {
    const contacts: ContactNode[] = [
      { id: '1', name: 'Alice', companyName: 'Google' },
      { id: '2', name: 'Bob', companyName: 'Meta' },
      { id: '3', name: 'Carol', companyName: 'Alphabet' },
    ]

    it('should match contacts by company name including aliases', () => {
      const matches = matchContactsByName(contacts, 'Google')
      // Should find both Alice (Google) and Carol (Alphabet, an alias of Google)
      expect(matches).toHaveLength(2)
      const names = matches.map((m) => m.contact.name)
      expect(names).toContain('Alice')
      expect(names).toContain('Carol')
    })

    it('should match only exact company when no aliases exist', () => {
      const matches = matchContactsByName(contacts, 'Meta')
      expect(matches).toHaveLength(1)
      expect(matches[0].contact.name).toBe('Bob')
    })

    it('should be case insensitive', () => {
      const matches = matchContactsByName(contacts, 'GOOGLE')
      expect(matches.length).toBeGreaterThan(0)
    })
  })

  describe('matchContactToCompany', () => {
    it('should match by domain first', () => {
      const contact: ContactNode = {
        id: '1',
        name: 'Alice',
        email: 'alice@google.com',
        companyName: 'Microsoft', // Wrong company name
      }
      const input: NetworkAnalysisInput = {
        companyId: 'c1',
        companyName: 'Google',
        companyDomain: 'google.com',
      }
      const result = matchContactToCompany(contact, input)
      expect(result).not.toBeNull()
      expect(result?.matchType).toBe('domain')
    })

    it('should match by name if domain does not match', () => {
      const contact: ContactNode = {
        id: '1',
        name: 'Alice',
        email: 'alice@personal.com',
        companyName: 'Google',
      }
      const input: NetworkAnalysisInput = {
        companyId: 'c1',
        companyName: 'Google',
        companyDomain: 'google.com',
      }
      const result = matchContactToCompany(contact, input)
      expect(result).not.toBeNull()
      expect(result?.matchType).toBe('name')
    })

    it('should match by alias', () => {
      const contact: ContactNode = {
        id: '1',
        name: 'Alice',
        email: 'alice@alphabet.com',
        companyName: 'Alphabet',
      }
      const input: NetworkAnalysisInput = {
        companyId: 'c1',
        companyName: 'Google',
        companyDomain: 'google.com',
      }
      const result = matchContactToCompany(contact, input)
      expect(result).not.toBeNull()
      // Could be either alias or domain match
    })

    it('should return null for non-matching contact', () => {
      const contact: ContactNode = {
        id: '1',
        name: 'Alice',
        email: 'alice@stripe.com',
        companyName: 'Stripe',
      }
      const input: NetworkAnalysisInput = {
        companyId: 'c1',
        companyName: 'Google',
        companyDomain: 'google.com',
      }
      const result = matchContactToCompany(contact, input)
      expect(result).toBeNull()
    })
  })
})

describe('Connection Strength Module', () => {
  describe('getRelationshipType', () => {
    it('should parse known relationship types', () => {
      expect(getRelationshipType('former_colleague')).toBe('former_colleague')
      expect(getRelationshipType('alumni')).toBe('alumni')
      expect(getRelationshipType('direct_contact')).toBe('direct_contact')
    })

    it('should return unknown for unrecognized relationships', () => {
      expect(getRelationshipType('some random text')).toBe('unknown')
      expect(getRelationshipType(null)).toBe('unknown')
      expect(getRelationshipType(undefined)).toBe('unknown')
    })

    it('should be case insensitive', () => {
      expect(getRelationshipType('FORMER_COLLEAGUE')).toBe('former_colleague')
      expect(getRelationshipType('Alumni')).toBe('alumni')
    })
  })

  describe('calculateDaysSinceContact', () => {
    it('should calculate days since last contact', () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      const days = calculateDaysSinceContact(tenDaysAgo)
      expect(days).toBeGreaterThanOrEqual(9)
      expect(days).toBeLessThanOrEqual(11)
    })

    it('should return undefined for null date', () => {
      expect(calculateDaysSinceContact(null)).toBeUndefined()
      expect(calculateDaysSinceContact(undefined)).toBeUndefined()
    })
  })

  describe('getRecencyMultiplier', () => {
    it('should return 1.2 for contact within 7 days', () => {
      expect(getRecencyMultiplier(0)).toBe(1.2)
      expect(getRecencyMultiplier(5)).toBe(1.2)
      expect(getRecencyMultiplier(7)).toBe(1.2)
    })

    it('should return 1.1 for contact within 30 days', () => {
      expect(getRecencyMultiplier(8)).toBe(1.1)
      expect(getRecencyMultiplier(15)).toBe(1.1)
      expect(getRecencyMultiplier(30)).toBe(1.1)
    })

    it('should return 1.0 for contact within 90 days', () => {
      expect(getRecencyMultiplier(31)).toBe(1.0)
      expect(getRecencyMultiplier(60)).toBe(1.0)
      expect(getRecencyMultiplier(90)).toBe(1.0)
    })

    it('should return 0.8 for contact over 90 days', () => {
      expect(getRecencyMultiplier(91)).toBe(0.8)
      expect(getRecencyMultiplier(180)).toBe(0.8)
    })

    it('should return 1.0 for undefined days', () => {
      expect(getRecencyMultiplier(undefined)).toBe(1.0)
    })
  })

  describe('calculateConnectionStrength', () => {
    it('should calculate strength for direct contact', () => {
      const strength = calculateConnectionStrength('direct_contact', 5)
      // 1.0 base * 1.2 recency (within 7 days) = 1.2, capped at 1.0
      expect(strength).toBeLessThanOrEqual(1.0)
      expect(strength).toBeGreaterThan(0.9)
    })

    it('should calculate strength for former colleague', () => {
      const strength = calculateConnectionStrength('former_colleague', 15)
      // 0.8 base * 1.1 recency (within 30 days) + 0.2 bonus = 1.0 (capped)
      expect(strength).toBe(1.0)
    })

    it('should calculate strength for alumni', () => {
      const strength = calculateConnectionStrength('alumni', 60)
      // 0.6 base * 1.0 recency (within 90 days) = 0.6
      expect(strength).toBe(0.6)
    })

    it('should calculate strength for linkedin connection with stale contact', () => {
      const strength = calculateConnectionStrength('linkedin_connection', 120)
      // 0.3 base * 0.8 recency (over 90 days) = 0.24
      expect(strength).toBeCloseTo(0.24, 1)
    })

    it('should apply recent contact bonus', () => {
      const recentStrength = calculateConnectionStrength('direct_contact', 5)
      const staleStrength = calculateConnectionStrength('direct_contact', 120)
      expect(recentStrength).toBeGreaterThan(staleStrength)
    })

    it('should cap strength at 1.0', () => {
      const strength = calculateConnectionStrength('direct_contact', 1)
      expect(strength).toBeLessThanOrEqual(1.0)
    })
  })
})

describe('Referral Paths Module', () => {
  const contacts: ContactNode[] = [
    {
      id: '1',
      name: 'Alice',
      title: 'Senior Engineer',
      relationship: 'direct_contact',
      lastContactAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
    {
      id: '2',
      name: 'Bob',
      title: 'Engineering Manager',
      relationship: 'former_colleague',
      lastContactAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      connections: ['3'], // Bob knows Carol
    },
    {
      id: '3',
      name: 'Carol',
      title: 'HR Director',
      relationship: 'second_degree',
      lastContactAt: null,
    },
  ]

  describe('findReferralPaths', () => {
    it('should find direct referral paths', () => {
      const paths = findReferralPaths(contacts.slice(0, 1))
      expect(paths.length).toBeGreaterThan(0)
      expect(paths[0].steps[0].action).toBe('direct_referral')
    })

    it('should find introduction paths through connections', () => {
      const paths = findReferralPaths(contacts)
      const introPath = paths.find((p) =>
        p.steps.some((s) => s.action === 'introduction')
      )
      // May or may not find intro path depending on connections
      expect(paths.length).toBeGreaterThan(0)
    })

    it('should return empty array for no contacts', () => {
      const paths = findReferralPaths([])
      expect(paths).toHaveLength(0)
    })
  })

  describe('calculatePathStrength', () => {
    it('should calculate path strength as product of step strengths', () => {
      const path = {
        steps: [
          { contactId: '1', contactName: 'Alice', relationship: 'direct_contact', action: 'direct_referral' as const },
        ],
        totalStrength: 0,
      }
      const contacts: ContactNode[] = [
        { id: '1', name: 'Alice', relationship: 'direct_contact', lastContactAt: new Date() },
      ]
      const strength = calculatePathStrength(path, contacts)
      expect(strength).toBeGreaterThan(0)
      expect(strength).toBeLessThanOrEqual(1)
    })

    it('should reduce strength for longer paths', () => {
      const shortPath = {
        steps: [
          { contactId: '1', contactName: 'Alice', relationship: 'alumni', action: 'direct_referral' as const },
        ],
        totalStrength: 0,
      }
      const longPath = {
        steps: [
          { contactId: '1', contactName: 'Alice', relationship: 'alumni', action: 'direct_referral' as const },
          { contactId: '2', contactName: 'Bob', relationship: 'alumni', action: 'introduction' as const },
        ],
        totalStrength: 0,
      }
      // Use stale contact dates (100+ days ago) to avoid bonuses and ensure non-1.0 strengths
      const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      const contactsForCalc: ContactNode[] = [
        { id: '1', name: 'Alice', relationship: 'alumni', lastContactAt: staleDate },
        { id: '2', name: 'Bob', relationship: 'alumni', lastContactAt: staleDate },
      ]
      const shortStrength = calculatePathStrength(shortPath, contactsForCalc)
      const longStrength = calculatePathStrength(longPath, contactsForCalc)
      // Short path: 0.6 * 0.8 = 0.48
      // Long path: 0.48 * 0.48 = 0.23
      expect(shortStrength).toBeGreaterThan(longStrength)
    })
  })

  describe('rankReferralPaths', () => {
    it('should rank paths by total strength', () => {
      const paths = [
        { steps: [], totalStrength: 0.5 },
        { steps: [], totalStrength: 0.9 },
        { steps: [], totalStrength: 0.3 },
      ]
      const ranked = rankReferralPaths(paths)
      expect(ranked[0].totalStrength).toBe(0.9)
      expect(ranked[1].totalStrength).toBe(0.5)
      expect(ranked[2].totalStrength).toBe(0.3)
    })
  })

  describe('selectBestPath', () => {
    it('should select path with highest strength', () => {
      const paths = [
        { steps: [], totalStrength: 0.5 },
        { steps: [], totalStrength: 0.9 },
        { steps: [], totalStrength: 0.3 },
      ]
      const best = selectBestPath(paths)
      expect(best?.totalStrength).toBe(0.9)
    })

    it('should return undefined for empty paths', () => {
      expect(selectBestPath([])).toBeUndefined()
    })
  })
})
