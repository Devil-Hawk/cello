// BYOK provider: Apollo.io people search (https://apolloio.github.io/apollo-api-docs/).
//
// OFF BY DEFAULT — only called by lib/contacts/sources.ts when the user has
// stored an Apollo key at profiles.preferences.api_keys.apollo (read via
// lib/contacts/keys.ts). Absent key => sources.ts never calls this file.
//
// FAILURE-ISOLATED: nothing here throws. Any HTTP error, timeout, or
// malformed response resolves to an empty array, never a throw — an Apollo
// outage (or an account without Apollo credits) can never break contact
// sourcing.
//
// NOTE: Apollo's people-search endpoint is POST with a JSON body (unlike
// Hunter's GET+query-string endpoints), so this file carries its own small
// POST-capable fetch instead of lib/sources/util's getJson (GET-only). Same
// SSRF guard (assertAllowedHost, HTTPS-only host allowlist) and no-redirect
// policy as every other outbound fetch in this codebase.

import { assertAllowedHost } from '@/lib/ats/http'
import type { ContactCandidate } from '../sources'

const APOLLO_HOST = new Set(['api.apollo.io'])
const DEFAULT_TIMEOUT_MS = 8000
const APOLLO_SEARCH_URL = 'https://api.apollo.io/v1/mixed_people/search'

interface ApolloPerson {
  name?: string | null
  first_name?: string | null
  last_name?: string | null
  title?: string | null
  email?: string | null
  email_status?: string | null
  linkedin_url?: string | null
}
interface ApolloSearchResponse {
  people?: ApolloPerson[]
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  assertAllowedHost(url, APOLLO_HOST)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Apollo HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export interface ApolloSearchOptions {
  apiKey: string
  domain: string
  companyName?: string | null
  /** Job titles to bias the search toward (e.g. hiring-manager-shaped titles for the role being sourced). */
  titles?: string[]
  limit?: number
  timeoutMs?: number
}

/** People Search: named individuals at a company domain, optionally filtered by title. */
export async function apolloPeopleSearch(opts: ApolloSearchOptions): Promise<ContactCandidate[]> {
  const domain = opts.domain.trim().toLowerCase()
  if (!opts.apiKey || !domain) return []
  const perPage = Math.min(25, Math.max(1, opts.limit ?? 10))
  try {
    const json = await postJson<ApolloSearchResponse>(
      APOLLO_SEARCH_URL,
      {
        api_key: opts.apiKey,
        q_organization_domains: domain,
        person_titles: opts.titles && opts.titles.length > 0 ? opts.titles : undefined,
        page: 1,
        per_page: perPage,
      },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )
    const people = json.people ?? []
    const out: ContactCandidate[] = []
    for (const p of people) {
      const name = (p.name || [p.first_name, p.last_name].filter(Boolean).join(' ')).trim() || null
      const rawEmail = typeof p.email === 'string' ? p.email.toLowerCase() : null
      // Apollo commonly withholds the real address behind a locked
      // placeholder (e.g. "email_not_unlocked@domain.com") unless the
      // account has unlocked credits for that person — never treat that
      // placeholder as a real address.
      const email = rawEmail && rawEmail.includes('@') && !rawEmail.includes('not_unlocked') ? rawEmail : null
      if (!name && !email) continue
      out.push({
        name,
        email,
        title: p.title || null,
        linkedinUrl: p.linkedin_url || null,
        source: 'apollo',
        confidence: email ? 0.6 : 0.4,
        verified: p.email_status === 'verified',
        basis: `Found via Apollo.io people search for ${opts.companyName || domain} (${domain}).`,
      })
    }
    return out
  } catch {
    return []
  }
}
