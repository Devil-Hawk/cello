/**
 * Connection Strength Calculator
 *
 * Calculates the strength of connections based on:
 * 1. Relationship type (direct contact, colleague, alumni, etc.)
 * 2. Recency of last contact
 * 3. Additional factors (recent contact bonus)
 */

import type { RelationshipType, ContactNode, NetworkContact } from './types'
import {
  RELATIONSHIP_BASE_SCORES,
  RECENCY_MULTIPLIERS,
  RECENCY_THRESHOLDS,
  RECENT_CONTACT_BONUS,
} from './types'

/**
 * Parse relationship string to known type
 */
export function getRelationshipType(relationship: string | null | undefined): RelationshipType {
  if (!relationship) return 'unknown'

  const normalized = relationship.toLowerCase().trim()

  // Check for exact matches
  if (normalized === 'direct_contact' || normalized === 'direct contact') {
    return 'direct_contact'
  }
  if (normalized === 'former_colleague' || normalized === 'former colleague') {
    return 'former_colleague'
  }
  if (normalized === 'alumni') {
    return 'alumni'
  }
  if (normalized === 'linkedin_connection' || normalized === 'linkedin connection' || normalized === 'linkedin') {
    return 'linkedin_connection'
  }
  if (normalized === 'second_degree' || normalized === 'second degree' || normalized === '2nd degree') {
    return 'second_degree'
  }

  // Check for partial matches
  if (normalized.includes('colleague') || normalized.includes('coworker') || normalized.includes('worked with')) {
    return 'former_colleague'
  }
  if (normalized.includes('alumni') || normalized.includes('school') || normalized.includes('university')) {
    return 'alumni'
  }
  if (normalized.includes('linkedin')) {
    return 'linkedin_connection'
  }
  if (normalized.includes('friend of') || normalized.includes('knows')) {
    return 'second_degree'
  }

  return 'unknown'
}

/**
 * Calculate days since last contact
 */
export function calculateDaysSinceContact(lastContactAt: Date | null | undefined): number | undefined {
  if (!lastContactAt) return undefined

  const now = new Date()
  const lastContact = new Date(lastContactAt)
  const diffMs = now.getTime() - lastContact.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  return diffDays
}

/**
 * Get recency multiplier based on days since last contact
 */
export function getRecencyMultiplier(daysSinceContact: number | undefined): number {
  if (daysSinceContact === undefined) {
    return RECENCY_MULTIPLIERS.RECENT_90_DAYS // Default to neutral
  }

  if (daysSinceContact <= RECENCY_THRESHOLDS.VERY_RECENT) {
    return RECENCY_MULTIPLIERS.RECENT_7_DAYS
  }
  if (daysSinceContact <= RECENCY_THRESHOLDS.RECENT) {
    return RECENCY_MULTIPLIERS.RECENT_30_DAYS
  }
  if (daysSinceContact <= RECENCY_THRESHOLDS.MODERATE) {
    return RECENCY_MULTIPLIERS.RECENT_90_DAYS
  }

  return RECENCY_MULTIPLIERS.STALE
}

/**
 * Calculate connection strength for a relationship
 *
 * @param relationship - The relationship type string
 * @param daysSinceContact - Days since last contact (optional)
 * @returns Strength value between 0 and 1
 */
export function calculateConnectionStrength(
  relationship: string | null | undefined,
  daysSinceContact?: number
): number {
  const relationshipType = getRelationshipType(relationship)
  const baseScore = RELATIONSHIP_BASE_SCORES[relationshipType]

  // Apply recency multiplier
  const recencyMultiplier = getRecencyMultiplier(daysSinceContact)
  let strength = baseScore * recencyMultiplier

  // Apply recent contact bonus (if within 30 days)
  if (daysSinceContact !== undefined && daysSinceContact <= RECENCY_THRESHOLDS.RECENT) {
    strength += RECENT_CONTACT_BONUS
  }

  // Cap at 1.0
  return Math.min(1.0, strength)
}

/**
 * Convert a ContactNode to NetworkContact with calculated strength
 */
export function toNetworkContact(contact: ContactNode): NetworkContact {
  const daysSinceContact = calculateDaysSinceContact(contact.lastContactAt)
  const connectionStrength = calculateConnectionStrength(contact.relationship, daysSinceContact)

  return {
    contactId: contact.id,
    name: contact.name,
    title: contact.title ?? undefined,
    connectionStrength,
    lastContactDays: daysSinceContact,
  }
}

/**
 * Sort contacts by connection strength (highest first)
 */
export function sortByConnectionStrength(contacts: NetworkContact[]): NetworkContact[] {
  return [...contacts].sort((a, b) => b.connectionStrength - a.connectionStrength)
}

/**
 * Filter contacts above a minimum strength threshold
 */
export function filterByMinimumStrength(
  contacts: NetworkContact[],
  minStrength: number
): NetworkContact[] {
  return contacts.filter((c) => c.connectionStrength >= minStrength)
}

/**
 * Get the strongest connection from a list
 */
export function getStrongestConnection(contacts: NetworkContact[]): NetworkContact | undefined {
  if (contacts.length === 0) return undefined

  return contacts.reduce((strongest, current) =>
    current.connectionStrength > strongest.connectionStrength ? current : strongest
  )
}

/**
 * Calculate aggregate strength for multiple connections to a company
 * Uses a weighted average where stronger connections count more
 */
export function calculateAggregateStrength(contacts: NetworkContact[]): number {
  if (contacts.length === 0) return 0

  // Weight by strength (stronger connections get more weight)
  const totalWeight = contacts.reduce((sum, c) => sum + c.connectionStrength, 0)
  const weightedSum = contacts.reduce(
    (sum, c) => sum + c.connectionStrength * c.connectionStrength,
    0
  )

  if (totalWeight === 0) return 0

  return weightedSum / totalWeight
}
