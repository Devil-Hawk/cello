/**
 * Network Agent specific types
 *
 * Types for mapping contacts to companies and finding referral paths.
 */

import type { AgentResult } from '../types'

/**
 * Extended contact information for network analysis
 */
export interface NetworkContact {
  contactId: string
  name: string
  title?: string
  connectionStrength: number // 0-1
  lastContactDays?: number
}

/**
 * A single step in a referral path
 */
export interface ReferralStep {
  contactId: string
  contactName: string
  relationship: string
  action: 'direct_referral' | 'introduction' | 'information'
}

/**
 * A complete referral path through the network
 */
export interface ReferralPath {
  steps: ReferralStep[]
  totalStrength: number
}

/**
 * Result of network analysis for a company
 */
export interface NetworkResult extends AgentResult {
  data?: {
    companyId: string
    contacts: NetworkContact[]
    referralPaths: ReferralPath[]
    bestPath?: ReferralPath
  }
}

/**
 * Types of relationships for connection strength calculation
 */
export type RelationshipType =
  | 'direct_contact'
  | 'former_colleague'
  | 'alumni'
  | 'linkedin_connection'
  | 'second_degree'
  | 'unknown'

/**
 * Base scores for different relationship types
 */
export const RELATIONSHIP_BASE_SCORES: Record<RelationshipType, number> = {
  direct_contact: 1.0,
  former_colleague: 0.8,
  alumni: 0.6,
  second_degree: 0.4,
  linkedin_connection: 0.3,
  unknown: 0.2,
}

/**
 * Recency multipliers based on days since last contact
 */
export const RECENCY_MULTIPLIERS = {
  RECENT_7_DAYS: 1.2,
  RECENT_30_DAYS: 1.1,
  RECENT_90_DAYS: 1.0,
  STALE: 0.8,
} as const

/**
 * Recency thresholds in days
 */
export const RECENCY_THRESHOLDS = {
  VERY_RECENT: 7,
  RECENT: 30,
  MODERATE: 90,
} as const

/**
 * Bonus score for recent contact (within 30 days)
 */
export const RECENT_CONTACT_BONUS = 0.2

/**
 * Common company aliases for matching
 */
export const COMPANY_ALIASES: Record<string, string[]> = {
  google: ['alphabet', 'google llc', 'google inc'],
  meta: ['facebook', 'fb', 'meta platforms'],
  amazon: ['aws', 'amazon.com', 'amazon web services'],
  microsoft: ['msft', 'microsoft corporation'],
  apple: ['apple inc', 'apple computer'],
  netflix: ['netflix inc'],
  uber: ['uber technologies'],
  lyft: ['lyft inc'],
  airbnb: ['airbnb inc'],
  stripe: ['stripe inc'],
  openai: ['open ai'],
  anthropic: ['anthropic ai'],
}

/**
 * Input for network analysis
 */
export interface NetworkAnalysisInput {
  companyId: string
  companyName: string
  companyDomain?: string | null
}

/**
 * Extended contact with relationship details for graph traversal
 */
export interface ContactNode {
  id: string
  name: string
  title?: string | null
  email?: string | null
  companyId?: string | null
  companyName?: string
  relationship?: string | null
  lastContactAt?: Date | null
  connections?: string[] // IDs of connected contacts (for 2nd degree)
}

/**
 * Result of contact matching for a company
 */
export interface ContactMatchResult {
  contact: ContactNode
  matchType: 'domain' | 'name' | 'alias'
  confidence: number
}
