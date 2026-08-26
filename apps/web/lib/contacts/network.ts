// Contact-to-company matching, connection strength, and referral-path
// discovery for a target company — pure local graph analysis over the user's
// own contacts, no model calls (verified by reading every export below: the
// only inputs are ContactNode fields and plain string/date math).
//
// Ported from packages/agents/src/network/{contact-matcher,connection-
// strength,referral-paths,index}.ts as part of the langgraph port
// (docs/superpowers/specs/2026-08-16-langgraph-port-design.md, step 12) —
// app/api/agents/network/route.ts is the only caller of analyzeNetwork();
// components/contacts/contact-row.tsx calls calculateConnectionStrength/
// calculateDaysSinceContact directly for its own per-row strength badge, so
// those two stay exported top-level rather than folded into analyzeNetwork.
//
// NOT PORTED (unused by either caller and, unlike everything above, not
// reached by the analysis pipeline either — packages/agents' own
// AgentContext/Agent-class shell, NetworkAgent.analyzeAllCompanies/
// findBestTargetCompany/getNetworkSummary, connection-strength.ts's
// filterByMinimumStrength/getStrongestConnection/calculateAggregateStrength,
// and contact-matcher.ts's matchContactsByDomain/matchContactsByName — both
// superseded by matchContactToCompany's combined companyId+domain+alias
// check below, which is the one the original NetworkAgent actually called):
// nothing in apps/web calls them. Add back if a caller needs multi-company
// ranking, a strength summary string, or domain-only/name-only matching.

// --- shared types -------------------------------------------------------

/** A contact as seen by network analysis — the subset of a full Contact row
 *  this module actually reads. */
export interface ContactNode {
  id: string
  name: string
  title?: string | null
  email?: string | null
  companyId?: string | null
  companyName?: string
  relationship?: string | null
  lastContactAt?: Date | null
  /** IDs of contacts this contact can introduce (for a 2-hop path). */
  connections?: string[]
}

export interface NetworkAnalysisInput {
  companyId: string
  companyName: string
  companyDomain?: string | null
}

export interface NetworkContact {
  contactId: string
  name: string
  title?: string
  connectionStrength: number // 0-1
  lastContactDays?: number
}

export interface ReferralStep {
  contactId: string
  contactName: string
  relationship: string
  action: 'direct_referral' | 'introduction' | 'information'
}

export interface ReferralPath {
  steps: ReferralStep[]
  totalStrength: number
}

export interface NetworkAnalysisResult {
  companyId: string
  contacts: NetworkContact[]
  referralPaths: ReferralPath[]
  bestPath?: ReferralPath
}

type RelationshipType = 'direct_contact' | 'former_colleague' | 'alumni' | 'linkedin_connection' | 'second_degree' | 'unknown'

const RELATIONSHIP_BASE_SCORES: Record<RelationshipType, number> = {
  direct_contact: 1.0,
  former_colleague: 0.8,
  alumni: 0.6,
  second_degree: 0.4,
  linkedin_connection: 0.3,
  unknown: 0.2,
}

const RECENCY_THRESHOLDS = { VERY_RECENT: 7, RECENT: 30, MODERATE: 90 } as const
const RECENCY_MULTIPLIERS = { RECENT_7_DAYS: 1.2, RECENT_30_DAYS: 1.1, RECENT_90_DAYS: 1.0, STALE: 0.8 } as const
const RECENT_CONTACT_BONUS = 0.2

export interface ContactMatchResult {
  contact: ContactNode
  matchType: 'domain' | 'name' | 'alias'
  confidence: number
}

// --- connection strength (packages/agents/src/network/connection-
// strength.ts) --------------------------------------------------------------

export function getRelationshipType(relationship: string | null | undefined): RelationshipType {
  if (!relationship) return 'unknown'
  const normalized = relationship.toLowerCase().trim()

  if (normalized === 'direct_contact' || normalized === 'direct contact') return 'direct_contact'
  if (normalized === 'former_colleague' || normalized === 'former colleague') return 'former_colleague'
  if (normalized === 'alumni') return 'alumni'
  if (normalized === 'linkedin_connection' || normalized === 'linkedin connection' || normalized === 'linkedin') return 'linkedin_connection'
  if (normalized === 'second_degree' || normalized === 'second degree' || normalized === '2nd degree') return 'second_degree'

  if (normalized.includes('colleague') || normalized.includes('coworker') || normalized.includes('worked with')) return 'former_colleague'
  if (normalized.includes('alumni') || normalized.includes('school') || normalized.includes('university')) return 'alumni'
  if (normalized.includes('linkedin')) return 'linkedin_connection'
  if (normalized.includes('friend of') || normalized.includes('knows')) return 'second_degree'

  return 'unknown'
}

/** Days since `lastContactAt`, or undefined when there is no date on file. */
export function calculateDaysSinceContact(lastContactAt: Date | null | undefined): number | undefined {
  if (!lastContactAt) return undefined
  const diffMs = Date.now() - new Date(lastContactAt).getTime()
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

export function getRecencyMultiplier(daysSinceContact: number | undefined): number {
  if (daysSinceContact === undefined) return RECENCY_MULTIPLIERS.RECENT_90_DAYS // neutral default
  if (daysSinceContact <= RECENCY_THRESHOLDS.VERY_RECENT) return RECENCY_MULTIPLIERS.RECENT_7_DAYS
  if (daysSinceContact <= RECENCY_THRESHOLDS.RECENT) return RECENCY_MULTIPLIERS.RECENT_30_DAYS
  if (daysSinceContact <= RECENCY_THRESHOLDS.MODERATE) return RECENCY_MULTIPLIERS.RECENT_90_DAYS
  return RECENCY_MULTIPLIERS.STALE
}

/** Strength (0-1) of a relationship, from its type and how recently the
 *  contact was last touched. */
export function calculateConnectionStrength(relationship: string | null | undefined, daysSinceContact?: number): number {
  const baseScore = RELATIONSHIP_BASE_SCORES[getRelationshipType(relationship)]
  let strength = baseScore * getRecencyMultiplier(daysSinceContact)
  if (daysSinceContact !== undefined && daysSinceContact <= RECENCY_THRESHOLDS.RECENT) strength += RECENT_CONTACT_BONUS
  return Math.min(1.0, strength)
}

function toNetworkContact(contact: ContactNode): NetworkContact {
  const daysSinceContact = calculateDaysSinceContact(contact.lastContactAt)
  return {
    contactId: contact.id,
    name: contact.name,
    title: contact.title ?? undefined,
    connectionStrength: calculateConnectionStrength(contact.relationship, daysSinceContact),
    lastContactDays: daysSinceContact,
  }
}

function sortByConnectionStrength(contacts: NetworkContact[]): NetworkContact[] {
  return [...contacts].sort((a, b) => b.connectionStrength - a.connectionStrength)
}

// --- contact matching (packages/agents/src/network/contact-matcher.ts) -----

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com',
])

const COMPANY_SUFFIXES = [
  ' inc.', ' inc', ' llc', ' ltd', ' ltd.', ' corp.', ' corp', ' corporation',
  ' co.', ' company', ' technologies', ' tech', ' platforms',
]

const COMPANY_ALIASES: Record<string, string[]> = {
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

export function normalizeCompanyName(name: string): string {
  let normalized = name.toLowerCase().trim()
  for (const suffix of COMPANY_SUFFIXES) {
    if (normalized.endsWith(suffix)) normalized = normalized.slice(0, -suffix.length).trim()
  }
  return normalized.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function resolveCompanyAliases(companyName: string): string[] {
  const normalized = normalizeCompanyName(companyName)
  const aliases = new Set<string>([normalized])
  for (const [canonical, aliasList] of Object.entries(COMPANY_ALIASES)) {
    const allNames = [canonical, ...aliasList].map(normalizeCompanyName)
    if (allNames.includes(normalized)) {
      for (const alias of allNames) aliases.add(alias)
    }
  }
  return Array.from(aliases)
}

function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const parts = email.toLowerCase().split('@')
  return parts.length === 2 ? parts[1] : null
}

function isPersonalEmailDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase())
}

function matchByDomainWithAliases(contact: ContactNode, input: NetworkAnalysisInput): ContactMatchResult | null {
  const emailDomain = extractEmailDomain(contact.email)
  if (!emailDomain || isPersonalEmailDomain(emailDomain)) return null

  const targetDomains = new Set<string>()
  if (input.companyDomain) targetDomains.add(input.companyDomain.toLowerCase())
  for (const alias of resolveCompanyAliases(input.companyName)) {
    if (alias === 'google' || alias === 'alphabet') {
      targetDomains.add('google.com')
      targetDomains.add('alphabet.com')
    }
    if (alias === 'meta' || alias === 'facebook') {
      targetDomains.add('meta.com')
      targetDomains.add('fb.com')
      targetDomains.add('facebook.com')
    }
    targetDomains.add(`${alias}.com`)
  }

  return targetDomains.has(emailDomain) ? { contact, matchType: 'domain', confidence: 1.0 } : null
}

/** Match a single contact to a company. Returns null if no match. */
export function matchContactToCompany(contact: ContactNode, input: NetworkAnalysisInput): ContactMatchResult | null {
  if (contact.companyId && contact.companyId === input.companyId) {
    return { contact, matchType: 'name', confidence: 1.0 }
  }

  const domainMatch = matchByDomainWithAliases(contact, input)
  if (domainMatch) return domainMatch

  if (contact.companyName) {
    const targetAliases = resolveCompanyAliases(input.companyName)
    const contactAliases = resolveCompanyAliases(contact.companyName)
    if (targetAliases.some((target) => contactAliases.includes(target))) {
      const isExactMatch = normalizeCompanyName(contact.companyName) === normalizeCompanyName(input.companyName)
      return { contact, matchType: isExactMatch ? 'name' : 'alias', confidence: isExactMatch ? 1.0 : 0.9 }
    }
  }

  return null
}

/** Every contact that matches a company, highest confidence first. */
function findMatchingContacts(contacts: ContactNode[], input: NetworkAnalysisInput): ContactMatchResult[] {
  const results: ContactMatchResult[] = []
  const matchedIds = new Set<string>()
  for (const contact of contacts) {
    const match = matchContactToCompany(contact, input)
    if (match && !matchedIds.has(contact.id)) {
      results.push(match)
      matchedIds.add(contact.id)
    }
  }
  return results.sort((a, b) => b.confidence - a.confidence)
}

// --- referral paths (packages/agents/src/network/referral-paths.ts) --------

function determineAction(connectionStrength: number, isDirectConnection: boolean): ReferralStep['action'] {
  if (connectionStrength >= 0.7 && isDirectConnection) return 'direct_referral'
  if (connectionStrength >= 0.4) return 'introduction'
  return 'information'
}

function createStep(contact: ContactNode, isDirectConnection = true): ReferralStep {
  const strength = calculateConnectionStrength(contact.relationship, calculateDaysSinceContact(contact.lastContactAt))
  return {
    contactId: contact.id,
    contactName: contact.name,
    relationship: contact.relationship || 'unknown',
    action: determineAction(strength, isDirectConnection),
  }
}

function findDirectPaths(contacts: ContactNode[]): ReferralPath[] {
  return contacts.map((contact) => ({
    steps: [createStep(contact, true)],
    totalStrength: calculateConnectionStrength(contact.relationship, calculateDaysSinceContact(contact.lastContactAt)),
  }))
}

/** Two-hop paths through a contact's own connections. */
function findIntroductionPaths(contacts: ContactNode[]): ReferralPath[] {
  const paths: ReferralPath[] = []
  const contactMap = new Map(contacts.map((c) => [c.id, c]))

  for (const contact of contacts) {
    if (!contact.connections || contact.connections.length === 0) continue
    for (const connectedId of contact.connections) {
      const connectedContact = contactMap.get(connectedId)
      if (!connectedContact) continue

      const firstStrength = calculateConnectionStrength(contact.relationship, calculateDaysSinceContact(contact.lastContactAt))
      const secondStrength = calculateConnectionStrength(
        connectedContact.relationship,
        calculateDaysSinceContact(connectedContact.lastContactAt)
      )
      paths.push({
        steps: [createStep(contact, true), createStep(connectedContact, false)],
        // Diminishes with hops — the product of both legs' strength.
        totalStrength: firstStrength * secondStrength,
      })
    }
  }
  return paths
}

export function findReferralPaths(contacts: ContactNode[]): ReferralPath[] {
  if (contacts.length === 0) return []
  return [...findDirectPaths(contacts), ...findIntroductionPaths(contacts)]
}

/** Recompute a path's strength from scratch against a contact list — the
 *  product of each step's connection strength (diminishes with hops). A
 *  step whose contact can't be found costs a flat 0.3 rather than aborting,
 *  so one stale reference doesn't zero out an otherwise-valid path. */
export function calculatePathStrength(path: ReferralPath, contacts: ContactNode[]): number {
  if (path.steps.length === 0) return 0
  const contactMap = new Map(contacts.map((c) => [c.id, c]))
  let totalStrength = 1.0
  for (const step of path.steps) {
    const contact = contactMap.get(step.contactId)
    if (!contact) {
      totalStrength *= 0.3
      continue
    }
    totalStrength *= calculateConnectionStrength(contact.relationship, calculateDaysSinceContact(contact.lastContactAt))
  }
  return totalStrength
}

export function rankReferralPaths(paths: ReferralPath[]): ReferralPath[] {
  return [...paths].sort((a, b) => b.totalStrength - a.totalStrength)
}

export function selectBestPath(paths: ReferralPath[]): ReferralPath | undefined {
  if (paths.length === 0) return undefined
  return paths.reduce((best, current) => (current.totalStrength > best.totalStrength ? current : best))
}

/** Keeps only the strongest path to each end contact. */
function deduplicatePaths(paths: ReferralPath[]): ReferralPath[] {
  const bestPathByEndContact = new Map<string, ReferralPath>()
  for (const path of paths) {
    if (path.steps.length === 0) continue
    const endContactId = path.steps[path.steps.length - 1].contactId
    const existing = bestPathByEndContact.get(endContactId)
    if (!existing || path.totalStrength > existing.totalStrength) bestPathByEndContact.set(endContactId, path)
  }
  return Array.from(bestPathByEndContact.values())
}

// --- entry point ---------------------------------------------------------

/** Find the user's contacts at a company, scored by connection strength, and
 *  rank the referral paths through them. Mirrors packages/agents'
 *  NetworkAgent#analyzeCompany. */
export function analyzeNetwork(input: NetworkAnalysisInput, contacts: ContactNode[]): NetworkAnalysisResult {
  const matched = findMatchingContacts(contacts, input).map((r) => r.contact)
  if (matched.length === 0) {
    return { companyId: input.companyId, contacts: [], referralPaths: [] }
  }

  const rankedPaths = rankReferralPaths(deduplicatePaths(findReferralPaths(matched)))

  return {
    companyId: input.companyId,
    contacts: sortByConnectionStrength(matched.map(toNetworkContact)),
    referralPaths: rankedPaths,
    bestPath: selectBestPath(rankedPaths),
  }
}
