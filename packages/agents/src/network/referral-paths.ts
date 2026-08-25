/**
 * Referral Paths - Find and rank referral paths through network
 *
 * This module handles:
 * 1. Finding direct referral paths
 * 2. Finding introduction paths (through mutual connections)
 * 3. Ranking paths by strength
 */

import type { ContactNode, ReferralPath, ReferralStep } from './types'
import { calculateConnectionStrength, calculateDaysSinceContact } from './connection-strength'

/**
 * Determine the action type based on relationship strength
 */
function determineAction(
  connectionStrength: number,
  isDirectConnection: boolean
): ReferralStep['action'] {
  if (connectionStrength >= 0.7 && isDirectConnection) {
    return 'direct_referral'
  }
  if (connectionStrength >= 0.4) {
    return 'introduction'
  }
  return 'information'
}

/**
 * Create a referral step from a contact
 */
function createStep(contact: ContactNode, isDirectConnection: boolean = true): ReferralStep {
  const daysSinceContact = calculateDaysSinceContact(contact.lastContactAt)
  const strength = calculateConnectionStrength(contact.relationship, daysSinceContact)

  return {
    contactId: contact.id,
    contactName: contact.name,
    relationship: contact.relationship || 'unknown',
    action: determineAction(strength, isDirectConnection),
  }
}

/**
 * Find direct referral paths (single-hop)
 */
function findDirectPaths(contacts: ContactNode[]): ReferralPath[] {
  const paths: ReferralPath[] = []

  for (const contact of contacts) {
    const step = createStep(contact, true)
    const daysSinceContact = calculateDaysSinceContact(contact.lastContactAt)
    const strength = calculateConnectionStrength(contact.relationship, daysSinceContact)

    paths.push({
      steps: [step],
      totalStrength: strength,
    })
  }

  return paths
}

/**
 * Find introduction paths (two-hop through mutual connections)
 */
function findIntroductionPaths(contacts: ContactNode[]): ReferralPath[] {
  const paths: ReferralPath[] = []
  const contactMap = new Map(contacts.map((c) => [c.id, c]))

  for (const contact of contacts) {
    // Check if this contact has connections to other contacts
    if (!contact.connections || contact.connections.length === 0) continue

    for (const connectedId of contact.connections) {
      const connectedContact = contactMap.get(connectedId)
      if (!connectedContact) continue

      // Create two-step path: user -> contact -> connected contact
      const firstStep = createStep(contact, true)
      const secondStep = createStep(connectedContact, false)

      const firstStrength = calculateConnectionStrength(
        contact.relationship,
        calculateDaysSinceContact(contact.lastContactAt)
      )
      const secondStrength = calculateConnectionStrength(
        connectedContact.relationship,
        calculateDaysSinceContact(connectedContact.lastContactAt)
      )

      // Total strength is the product of individual strengths (diminishes with hops)
      const totalStrength = firstStrength * secondStrength

      paths.push({
        steps: [firstStep, secondStep],
        totalStrength,
      })
    }
  }

  return paths
}

/**
 * Find all referral paths through the network
 */
export function findReferralPaths(contacts: ContactNode[]): ReferralPath[] {
  if (contacts.length === 0) return []

  const directPaths = findDirectPaths(contacts)
  const introductionPaths = findIntroductionPaths(contacts)

  return [...directPaths, ...introductionPaths]
}

/**
 * Calculate the strength of a referral path
 */
export function calculatePathStrength(path: ReferralPath, contacts: ContactNode[]): number {
  if (path.steps.length === 0) return 0

  const contactMap = new Map(contacts.map((c) => [c.id, c]))
  let totalStrength = 1.0

  for (const step of path.steps) {
    const contact = contactMap.get(step.contactId)
    if (!contact) {
      // If contact not found, use a default low strength
      totalStrength *= 0.3
      continue
    }

    const daysSinceContact = calculateDaysSinceContact(contact.lastContactAt)
    const stepStrength = calculateConnectionStrength(contact.relationship, daysSinceContact)
    totalStrength *= stepStrength
  }

  return totalStrength
}

/**
 * Rank referral paths by total strength (highest first)
 */
export function rankReferralPaths(paths: ReferralPath[]): ReferralPath[] {
  return [...paths].sort((a, b) => b.totalStrength - a.totalStrength)
}

/**
 * Select the best referral path
 */
export function selectBestPath(paths: ReferralPath[]): ReferralPath | undefined {
  if (paths.length === 0) return undefined

  return paths.reduce((best, current) =>
    current.totalStrength > best.totalStrength ? current : best
  )
}

/**
 * Filter paths above a minimum strength threshold
 */
export function filterPathsByStrength(
  paths: ReferralPath[],
  minStrength: number
): ReferralPath[] {
  return paths.filter((p) => p.totalStrength >= minStrength)
}

/**
 * Limit paths to a maximum number of steps
 */
export function filterPathsByLength(paths: ReferralPath[], maxSteps: number): ReferralPath[] {
  return paths.filter((p) => p.steps.length <= maxSteps)
}

/**
 * Get a summary of the best path for display
 */
export function getPathSummary(path: ReferralPath): string {
  if (path.steps.length === 0) return 'No path available'

  const steps = path.steps.map((step) => {
    const actionText = {
      direct_referral: 'can refer you directly',
      introduction: 'can introduce you',
      information: 'can provide information',
    }[step.action]

    return `${step.contactName} (${step.relationship}) ${actionText}`
  })

  return steps.join(' -> ')
}

/**
 * Deduplicate paths that lead to the same end contact
 * Keeps only the strongest path to each end contact
 */
export function deduplicatePaths(paths: ReferralPath[]): ReferralPath[] {
  const bestPathByEndContact = new Map<string, ReferralPath>()

  for (const path of paths) {
    if (path.steps.length === 0) continue

    const endContactId = path.steps[path.steps.length - 1].contactId
    const existing = bestPathByEndContact.get(endContactId)

    if (!existing || path.totalStrength > existing.totalStrength) {
      bestPathByEndContact.set(endContactId, path)
    }
  }

  return Array.from(bestPathByEndContact.values())
}
