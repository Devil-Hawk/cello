// BYOK provider: Hunter.io (https://hunter.io) — domain search, single-person
// email finder, and email verifier.
//
// OFF BY DEFAULT: every export takes the key as an explicit parameter and is
// only ever invoked by lib/contacts/sources.ts when the user has stored a
// Hunter key at profiles.preferences.api_keys.hunter (read via
// lib/contacts/keys.ts). Absent key => sources.ts never calls this file.
//
// FAILURE-ISOLATED: nothing here throws. A bad key, a rate limit, a timeout,
// or a malformed response all resolve to an empty array / null so a Hunter
// outage can never break contact sourcing — the free path always still works.
//
// This is a SEPARATE, purpose-built client for the contact-sourcing pipeline —
// it returns full ContactCandidate rows with provenance (source/confidence/
// verified/basis). lib/outreach/hunter.ts's findContacts() is a different,
// narrower Hunter client the enricher agent (owned by another workstream)
// uses for its own insider-connection signal; both talk to the same Hunter
// API but serve different consumers and are intentionally not merged.

import { getJson } from '@/lib/sources/util'
import type { ContactCandidate } from '../sources'

const HUNTER_HOST = new Set(['api.hunter.io'])
const DEFAULT_TIMEOUT_MS = 8000

interface HunterEmailEntry {
  value: string
  first_name?: string | null
  last_name?: string | null
  position?: string | null
  confidence?: number | null
  linkedin?: string | null
}
interface HunterDomainSearchResponse {
  data?: { emails?: HunterEmailEntry[] }
}

export interface HunterSearchOptions {
  apiKey: string
  domain: string
  limit?: number
  timeoutMs?: number
}

/** Domain Search: every email Hunter has indexed for a domain, each with Hunter's own confidence score. */
export async function hunterDomainSearch(opts: HunterSearchOptions): Promise<ContactCandidate[]> {
  const domain = opts.domain.trim().toLowerCase()
  if (!opts.apiKey || !domain) return []
  const limit = Math.min(25, Math.max(1, opts.limit ?? 10))
  try {
    const json = await getJson<HunterDomainSearchResponse>(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=${limit}&api_key=${encodeURIComponent(opts.apiKey)}`,
      HUNTER_HOST,
      { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, retries: 1 }
    )
    const emails = json.data?.emails ?? []
    return emails
      .filter((e) => typeof e.value === 'string' && e.value.includes('@'))
      .map((e): ContactCandidate => {
        const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim() || null
        return {
          name,
          email: e.value.toLowerCase(),
          title: e.position || null,
          linkedinUrl: e.linkedin || null,
          source: 'hunter',
          confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence / 100)) : 0.5,
          // Domain search returns a confidence SCORE, not a pass/fail
          // deliverability check — never verified=true from this call alone.
          verified: false,
          basis: `Found via Hunter.io domain search for ${domain}.`,
        }
      })
  } catch {
    return []
  }
}

export interface HunterFinderOptions {
  apiKey: string
  domain: string
  /** Full name — split on whitespace into first/last for Hunter's params. */
  name: string
  timeoutMs?: number
}

interface HunterFinderResponse {
  data?: { email?: string | null; score?: number | null; position?: string | null }
}

/** Email Finder: Hunter's own best guess at ONE named person's address at a domain. */
export async function hunterEmailFinder(opts: HunterFinderOptions): Promise<ContactCandidate | null> {
  const domain = opts.domain.trim().toLowerCase()
  const parts = opts.name.trim().split(/\s+/).filter(Boolean)
  if (!opts.apiKey || !domain || parts.length < 2) return null
  const firstName = parts[0]
  const lastName = parts[parts.length - 1]
  try {
    const json = await getJson<HunterFinderResponse>(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${encodeURIComponent(opts.apiKey)}`,
      HUNTER_HOST,
      { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, retries: 1 }
    )
    const email = json.data?.email
    if (!email) return null
    return {
      name: opts.name,
      email: email.toLowerCase(),
      title: json.data?.position || null,
      linkedinUrl: null,
      source: 'hunter',
      confidence: typeof json.data?.score === 'number' ? Math.max(0, Math.min(1, json.data.score / 100)) : 0.5,
      verified: false,
      basis: `Found via Hunter.io's email finder for "${opts.name}" at ${domain}.`,
    }
  } catch {
    return null
  }
}

export type HunterVerifyStatus = 'deliverable' | 'undeliverable' | 'risky' | 'unknown'

export interface HunterVerifyResult {
  status: HunterVerifyStatus
  score: number | null
}

interface HunterVerifyResponse {
  data?: { status?: string; score?: number | null }
}

/** Email Verifier: confirms (or refutes) deliverability of ONE address — the only call in this file that can set verified=true. */
export async function hunterVerifyEmail(opts: { apiKey: string; email: string; timeoutMs?: number }): Promise<HunterVerifyResult | null> {
  if (!opts.apiKey || !opts.email.includes('@')) return null
  try {
    const json = await getJson<HunterVerifyResponse>(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(opts.email)}&api_key=${encodeURIComponent(opts.apiKey)}`,
      HUNTER_HOST,
      { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, retries: 1 }
    )
    const status = json.data?.status
    const known: HunterVerifyStatus[] = ['deliverable', 'undeliverable', 'risky']
    return {
      status: status && (known as string[]).includes(status) ? (status as HunterVerifyStatus) : 'unknown',
      score: typeof json.data?.score === 'number' ? json.data.score : null,
    }
  } catch {
    return null
  }
}
