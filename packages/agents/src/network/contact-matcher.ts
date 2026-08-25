/**
 * Contact Matcher - Matches contacts to companies
 *
 * This module handles:
 * 1. Matching contacts by company domain (email)
 * 2. Matching contacts by company name (with aliases)
 * 3. Fuzzy company name matching
 */

import type { ContactNode, ContactMatchResult, NetworkAnalysisInput } from './types'
import { COMPANY_ALIASES } from './types'

/**
 * Personal email domains to exclude from domain matching
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'protonmail.com',
  'mail.com',
  'live.com',
  'msn.com',
])

/**
 * Common company name suffixes to remove during normalization
 */
const COMPANY_SUFFIXES = [
  ' inc.',
  ' inc',
  ' llc',
  ' ltd',
  ' ltd.',
  ' corp.',
  ' corp',
  ' corporation',
  ' co.',
  ' company',
  ' technologies',
  ' tech',
  ' platforms',
]

/**
 * Normalize company name for comparison
 * - Lowercase
 * - Trim whitespace
 * - Remove common suffixes
 */
export function normalizeCompanyName(name: string): string {
  let normalized = name.toLowerCase().trim()

  // Remove common suffixes
  for (const suffix of COMPANY_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim()
    }
  }

  // Remove parentheses content but keep the text inside
  normalized = normalized.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()

  return normalized
}

/**
 * Get all aliases for a company name (including the original name)
 */
export function resolveCompanyAliases(companyName: string): string[] {
  const normalized = normalizeCompanyName(companyName)
  const aliases = new Set<string>([normalized])

  // Check if this name matches any known aliases
  for (const [canonical, aliasList] of Object.entries(COMPANY_ALIASES)) {
    const allNames = [canonical, ...aliasList].map(normalizeCompanyName)

    if (allNames.includes(normalized)) {
      // Add all aliases for this company
      for (const alias of allNames) {
        aliases.add(alias)
      }
    }
  }

  return Array.from(aliases)
}

/**
 * Extract domain from email address
 */
export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null

  const parts = email.toLowerCase().split('@')
  if (parts.length !== 2) return null

  return parts[1]
}

/**
 * Check if a domain is a personal email domain
 */
export function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase())
}

/**
 * Match contacts by email domain
 */
export function matchContactsByDomain(
  contacts: ContactNode[],
  companyDomain: string | null | undefined
): ContactMatchResult[] {
  if (!companyDomain) return []

  const targetDomain = companyDomain.toLowerCase()

  // Skip if target is a personal email domain
  if (isPersonalEmailDomain(targetDomain)) {
    return []
  }

  const results: ContactMatchResult[] = []

  for (const contact of contacts) {
    const emailDomain = extractEmailDomain(contact.email)
    if (!emailDomain) continue

    // Skip personal emails
    if (isPersonalEmailDomain(emailDomain)) continue

    // Check for exact domain match
    if (emailDomain === targetDomain) {
      results.push({
        contact,
        matchType: 'domain',
        confidence: 1.0,
      })
    }
  }

  return results
}

/**
 * Match contacts by company name (including aliases)
 */
export function matchContactsByName(
  contacts: ContactNode[],
  companyName: string
): ContactMatchResult[] {
  const targetAliases = resolveCompanyAliases(companyName)
  const results: ContactMatchResult[] = []

  for (const contact of contacts) {
    if (!contact.companyName) continue

    const contactCompanyNormalized = normalizeCompanyName(contact.companyName)
    const contactAliases = resolveCompanyAliases(contact.companyName)

    // Check if any of the contact's company aliases match target aliases
    const isMatch = targetAliases.some((target) => contactAliases.includes(target))

    if (isMatch) {
      // Determine if it's an exact match or alias match
      const isExactMatch = contactCompanyNormalized === normalizeCompanyName(companyName)

      results.push({
        contact,
        matchType: isExactMatch ? 'name' : 'alias',
        confidence: isExactMatch ? 1.0 : 0.9,
      })
    }
  }

  return results
}

/**
 * Check if a contact matches a company through domain matching
 * Also checks for company domain aliases (e.g., alphabet.com for Google)
 */
function matchByDomainWithAliases(
  contact: ContactNode,
  input: NetworkAnalysisInput
): ContactMatchResult | null {
  const emailDomain = extractEmailDomain(contact.email)
  if (!emailDomain || isPersonalEmailDomain(emailDomain)) {
    return null
  }

  // Get all domains associated with the target company
  const targetDomains = new Set<string>()

  if (input.companyDomain) {
    targetDomains.add(input.companyDomain.toLowerCase())
  }

  // Add domains for known aliases
  const aliases = resolveCompanyAliases(input.companyName)
  for (const alias of aliases) {
    // For known companies, add their domains
    if (alias === 'google' || alias === 'alphabet') {
      targetDomains.add('google.com')
      targetDomains.add('alphabet.com')
    }
    if (alias === 'meta' || alias === 'facebook') {
      targetDomains.add('meta.com')
      targetDomains.add('fb.com')
      targetDomains.add('facebook.com')
    }
    // Add domain based on alias name
    targetDomains.add(`${alias}.com`)
  }

  // Check if contact's email domain matches any target domain
  if (targetDomains.has(emailDomain)) {
    return {
      contact,
      matchType: 'domain',
      confidence: 1.0,
    }
  }

  return null
}

/**
 * Match a single contact to a company
 * Returns null if no match
 */
export function matchContactToCompany(
  contact: ContactNode,
  input: NetworkAnalysisInput
): ContactMatchResult | null {
  // First, try to match by company ID if available
  if (contact.companyId && contact.companyId === input.companyId) {
    return {
      contact,
      matchType: 'name',
      confidence: 1.0,
    }
  }

  // Second, try domain matching (including aliases)
  const domainMatch = matchByDomainWithAliases(contact, input)
  if (domainMatch) {
    return domainMatch
  }

  // Third, try company name matching (including aliases)
  if (contact.companyName) {
    const targetAliases = resolveCompanyAliases(input.companyName)
    const contactAliases = resolveCompanyAliases(contact.companyName)

    const isMatch = targetAliases.some((target) => contactAliases.includes(target))
    if (isMatch) {
      const isExactMatch =
        normalizeCompanyName(contact.companyName) === normalizeCompanyName(input.companyName)
      return {
        contact,
        matchType: isExactMatch ? 'name' : 'alias',
        confidence: isExactMatch ? 1.0 : 0.9,
      }
    }
  }

  return null
}

/**
 * Find all contacts that match a company
 */
export function findMatchingContacts(
  contacts: ContactNode[],
  input: NetworkAnalysisInput
): ContactMatchResult[] {
  const results: ContactMatchResult[] = []
  const matchedIds = new Set<string>()

  for (const contact of contacts) {
    const match = matchContactToCompany(contact, input)
    if (match && !matchedIds.has(contact.id)) {
      results.push(match)
      matchedIds.add(contact.id)
    }
  }

  // Sort by confidence (highest first)
  return results.sort((a, b) => b.confidence - a.confidence)
}
