/**
 * Network Agent - Maps contacts to companies and finds referral paths
 *
 * The Network Agent is responsible for:
 * 1. Identifying contacts who work at target companies
 * 2. Calculating connection strength (direct, 2nd degree, alumni)
 * 3. Suggesting referral paths for job applications
 * 4. All local processing (graph traversal on contact data)
 */

import type { Company, Contact } from '@cello/shared'
import type { Agent, AgentContext } from '../types'
import type {
  NetworkResult,
  NetworkContact,
  ReferralPath,
  ContactNode,
  NetworkAnalysisInput,
} from './types'
import { findMatchingContacts } from './contact-matcher'
import { toNetworkContact, sortByConnectionStrength } from './connection-strength'
import { findReferralPaths, rankReferralPaths, selectBestPath, deduplicatePaths } from './referral-paths'

// Re-export modules
export * from './types'
export * from './contact-matcher'
export * from './connection-strength'
export * from './referral-paths'

/**
 * Extended AgentContext with contacts support
 */
interface NetworkAgentContext extends AgentContext {
  contacts?: Contact[]
}

/**
 * Convert Contact from domain type to ContactNode for network analysis
 */
function contactToNode(contact: Contact, companyName?: string): ContactNode {
  return {
    id: contact.id,
    name: contact.name,
    title: contact.title,
    email: contact.email,
    companyId: contact.companyId,
    companyName: companyName,
    relationship: contact.relationship,
    lastContactAt: contact.lastContactAt,
    connections: [], // Will be populated if 2nd degree info is available
  }
}

/**
 * Build a map of company IDs to company names
 */
function buildCompanyNameMap(companies: Company[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const company of companies) {
    map.set(company.id, company.name)
  }
  return map
}

/**
 * NetworkAgent maps contacts to companies and finds referral paths.
 *
 * Usage:
 * ```typescript
 * const network = new NetworkAgent()
 *
 * // Analyze network for a company
 * const result = await network.execute({
 *   user: userProfile,
 *   companies: [targetCompany],
 *   contacts: userContacts
 * })
 *
 * // Get contacts at company and referral paths
 * console.log(result.data?.contacts)
 * console.log(result.data?.bestPath)
 * ```
 */
export class NetworkAgent implements Agent {
  name = 'Network'
  description = 'Maps contacts to companies and finds referral paths for job applications'

  /**
   * Main execution method - analyzes network for first company
   * Returns NetworkResult with contacts and referral paths
   */
  async execute(context: AgentContext): Promise<NetworkResult> {
    const startTime = Date.now()

    try {
      const { companies } = context
      const networkContext = context as NetworkAgentContext

      // Validation
      if (!companies || companies.length === 0) {
        return {
          success: false,
          error: 'No companies provided for network analysis',
          metadata: { duration: Date.now() - startTime },
        }
      }

      const contacts = networkContext.contacts || []

      // Analyze the first company (for single result interface)
      const company = companies[0]
      const companyNameMap = buildCompanyNameMap(companies)

      // Convert contacts to nodes with company names
      const contactNodes = contacts.map((c) =>
        contactToNode(c, c.companyId ? companyNameMap.get(c.companyId) : undefined)
      )

      const result = await this.analyzeCompany(
        {
          companyId: company.id,
          companyName: company.name,
          companyDomain: company.domain,
        },
        contactNodes
      )

      return {
        ...result,
        metadata: {
          duration: Date.now() - startTime,
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        metadata: { duration: Date.now() - startTime },
      }
    }
  }

  /**
   * Analyze network for a specific company
   */
  async analyzeCompany(
    input: NetworkAnalysisInput,
    contacts: ContactNode[]
  ): Promise<NetworkResult> {
    // Find contacts that work at this company
    const matchResults = findMatchingContacts(contacts, input)

    if (matchResults.length === 0) {
      return {
        success: true,
        data: {
          companyId: input.companyId,
          contacts: [],
          referralPaths: [],
        },
      }
    }

    // Convert matched contacts to NetworkContact with strength scores
    const matchedContacts = matchResults.map((r) => r.contact)
    const networkContacts = matchedContacts.map(toNetworkContact)
    const sortedContacts = sortByConnectionStrength(networkContacts)

    // Find referral paths through the network
    const allPaths = findReferralPaths(matchedContacts)
    const uniquePaths = deduplicatePaths(allPaths)
    const rankedPaths = rankReferralPaths(uniquePaths)
    const bestPath = selectBestPath(rankedPaths)

    return {
      success: true,
      data: {
        companyId: input.companyId,
        contacts: sortedContacts,
        referralPaths: rankedPaths,
        bestPath,
      },
    }
  }

  /**
   * Analyze network for multiple companies
   */
  async analyzeAllCompanies(
    companies: Company[],
    contacts: Contact[]
  ): Promise<Map<string, NetworkResult>> {
    const results = new Map<string, NetworkResult>()
    const companyNameMap = buildCompanyNameMap(companies)

    // Convert all contacts to nodes
    const contactNodes = contacts.map((c) =>
      contactToNode(c, c.companyId ? companyNameMap.get(c.companyId) : undefined)
    )

    for (const company of companies) {
      const result = await this.analyzeCompany(
        {
          companyId: company.id,
          companyName: company.name,
          companyDomain: company.domain,
        },
        contactNodes
      )
      results.set(company.id, result)
    }

    return results
  }

  /**
   * Find the best company to target based on network strength
   */
  async findBestTargetCompany(
    companies: Company[],
    contacts: Contact[]
  ): Promise<{ company: Company; result: NetworkResult } | null> {
    const analysisResults = await this.analyzeAllCompanies(companies, contacts)

    let bestCompany: Company | null = null
    let bestResult: NetworkResult | null = null
    let bestStrength = 0

    for (const company of companies) {
      const result = analysisResults.get(company.id)
      if (!result?.data?.bestPath) continue

      if (result.data.bestPath.totalStrength > bestStrength) {
        bestStrength = result.data.bestPath.totalStrength
        bestCompany = company
        bestResult = result
      }
    }

    if (!bestCompany || !bestResult) return null

    return { company: bestCompany, result: bestResult }
  }

  /**
   * Get a summary of network strength for a company
   */
  getNetworkSummary(result: NetworkResult): string {
    if (!result.success || !result.data) {
      return 'No network data available'
    }

    const { contacts, bestPath } = result.data

    if (contacts.length === 0) {
      return 'No contacts found at this company'
    }

    const strongContacts = contacts.filter((c) => c.connectionStrength >= 0.7)
    const moderateContacts = contacts.filter(
      (c) => c.connectionStrength >= 0.4 && c.connectionStrength < 0.7
    )
    const weakContacts = contacts.filter((c) => c.connectionStrength < 0.4)

    let summary = `Found ${contacts.length} contact(s) at this company:\n`
    summary += `- Strong connections (70%+): ${strongContacts.length}\n`
    summary += `- Moderate connections (40-70%): ${moderateContacts.length}\n`
    summary += `- Weak connections (<40%): ${weakContacts.length}\n`

    if (bestPath) {
      const pathType = bestPath.steps.length === 1 ? 'Direct' : 'Introduction'
      summary += `\nBest referral path: ${pathType} (${Math.round(bestPath.totalStrength * 100)}% strength)`
      summary += `\nPath: ${bestPath.steps.map((s) => s.contactName).join(' -> ')}`
    }

    return summary
  }
}
