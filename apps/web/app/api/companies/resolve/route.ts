import { NextRequest, NextResponse } from 'next/server'
import { withTrace } from '@/lib/trace/spans'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm, parseJsonLoose, MissingKeyError } from '@/lib/harness/llm'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { IDENTIFY } from '@/lib/ats/verify'
import { isValidToken } from '@/lib/ats/types'
import {
  lookupKnownCompanyByName,
  stripCompanySuffix,
  faviconForDomain,
} from '@/lib/companies/known-companies'

// Resolve a company NAME (not a URL) to a small ranked list of candidates the
// user can pick from — the name-first counterpart to /api/companies/verify.
//
// Strategy, cheapest first:
//   a. KNOWN_COMPANIES reverse lookup       — free, no network.
//   b. Look for Greenhouse/Lever/Ashby boards under the name — network, all
//      slugs × providers in parallel, each described by the employer name and
//      site the provider declares. These are only POSSIBLE matches (a slug that
//      exists says nothing about who owns it); the person picks, and the
//      refresh verifies a board against the company's domain.
//   c. LLM fallback                         — ONLY when a found nothing AND
//      the user has an OpenRouter key configured. Skipped silently otherwise
//      (never fails the request over a missing key). Its answer is validated
//      by actually fetching the suggested careerUrl before being trusted.
//
// NEVER returns a bare homepage as a careerUrl (path === '' or '/') — that is
// exactly what previously fed the garbage HTML-scraper fallback. A candidate
// with no verified board comes back with careerUrl: null; the caller inserts
// career_url as '' in that case (the companies.career_url column is NOT NULL
// in prod — '' is the established "no career page" sentinel already handled
// by getCompanyDomain/isBareHomepage elsewhere in the codebase).

export const dynamic = 'force-dynamic'

type Confidence = 'high' | 'medium' | 'low'
type Source = 'known' | 'possible' | 'ai'

export interface ResolveCandidate {
  name: string
  domain: string | null
  careerUrl: string | null
  source: Source
  confidence: Confidence
  logoUrl?: string
  /** For a 'possible' match: what the board says it is. */
  note?: string
}

const PROBE_TIMEOUT_MS = 5000
const MAX_CANDIDATES = 5
const MAX_SLUGS = 4
const MAX_NAME_LENGTH = 200

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

/** Derive candidate ATS board slugs from a company name (and its known domain, if any). */
function slugCandidates(name: string, domain?: string | null): string[] {
  const out: string[] = []
  const push = (s: string) => {
    if (s && isValidToken(s) && !out.includes(s)) out.push(s)
  }

  const base = stripCompanySuffix(name).toLowerCase()
  const cleaned = base.replace(/[^a-z0-9\s-]/g, ' ')
  const words = cleaned.split(/[\s-]+/).filter(Boolean)
  if (words.length > 0) {
    push(words.join('')) // "Open AI" -> "openai"
    push(words.join('-')) // "Open AI" -> "open-ai"
  }

  if (domain) {
    const host = domain.toLowerCase().replace(/^www\.|^jobs\.|^careers\./, '')
    const firstLabel = host.split('.')[0]
    push(firstLabel)
  }

  return out.slice(0, MAX_SLUGS)
}

/**
 * Boards that exist under this name on Greenhouse, Lever or Ashby, described by
 * what the PROVIDER says they are: the employer name and the site it declares.
 * A slug that exists proves nothing about who owns it ("atlas" on Ashby is an
 * Atlas Card board), so a hit is only ever a possible match for the person to
 * judge, never a career page: no careerUrl is offered for it, and when the
 * company is added the refresh verifies a board against its domain (lib/ats).
 */
async function findPossibleBoards(name: string): Promise<ResolveCandidate[]> {
  const slugs = slugCandidates(name, null)
  const providers = ['greenhouse', 'lever', 'ashby'] as const
  const tasks: Promise<ResolveCandidate | null>[] = []
  for (const slug of slugs) {
    for (const provider of providers) {
      tasks.push(
        (async () => {
          try {
            const identity = await IDENTIFY[provider]!(slug)
            const site = identity.homeUrls.map(siteHost).find((h): h is string => !!h)
            if (!identity.name && !site) return null
            const label = provider[0].toUpperCase() + provider.slice(1)
            return {
              name: identity.name ?? name,
              domain: site ?? null,
              careerUrl: null,
              source: 'possible' as const,
              confidence: 'low' as const,
              note: `${label} board named \u201c${identity.name ?? slug}\u201d${site ? ` \u00b7 ${site}` : ''}`,
              logoUrl: site ? faviconForDomain(site) : undefined,
            }
          } catch {
            return null
          }
        })()
      )
    }
  }
  const out: ResolveCandidate[] = []
  const seen = new Set<string>()
  for (const r of await Promise.allSettled(tasks)) {
    if (r.status !== 'fulfilled' || !r.value) continue
    const key = `${r.value.name.toLowerCase()}|${r.value.domain ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(r.value)
    }
  }
  return out
}

/** The host of a site a board declares, unless it is the provider's own. */
function siteHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    return /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|recruitee\.com)$/.test(host) ? null : host
  } catch {
    return null
  }
}

/** true when the URL has no meaningful path — the "epias GmbH homepage" failure mode. */
function isBareHomepage(url: URL): boolean {
  return (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash
}

/** Ask the LLM for {officialDomain, careerUrl}, then validate by fetching it. Never throws. */
async function resolveWithLlm(apiKeys: DecryptedApiKeys, name: string): Promise<ResolveCandidate | null> {
  let raw: string
  try {
    const result = await callLlm(apiKeys, {
      system:
        'You identify the official corporate domain and careers/jobs page URL for a company. ' +
        'Respond with JSON only: {"officialDomain": string | null, "careerUrl": string | null}. ' +
        'If you are not confident of the exact company, return both fields as null. Never invent a URL.',
      prompt: `Company name: ${name}`,
      json: true,
      maxTokens: 200,
      temperature: 0,
      name: 'resolve-company',
    })
    raw = result.content
  } catch (error) {
    if (error instanceof MissingKeyError) return null
    return null
  }

  let parsed: { officialDomain?: unknown; careerUrl?: unknown }
  try {
    parsed = parseJsonLoose(raw)
  } catch {
    return null
  }

  const careerUrlRaw = typeof parsed.careerUrl === 'string' ? parsed.careerUrl.trim() : ''
  const officialDomainRaw = typeof parsed.officialDomain === 'string' ? parsed.officialDomain.trim() : ''
  if (!careerUrlRaw) return null

  let parsedUrl: URL
  try {
    parsedUrl = new URL(careerUrlRaw)
  } catch {
    return null
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null
  // Never trust a bare homepage as a career URL, LLM-suggested or otherwise.
  if (isBareHomepage(parsedUrl)) return null

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(parsedUrl.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)',
          Accept: 'text/html,application/xhtml+xml',
        },
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return null
  } catch {
    return null
  }

  const domain = officialDomainRaw.replace(/^www\./, '') || parsedUrl.hostname.replace(/^www\./, '')
  return {
    name,
    domain,
    careerUrl: parsedUrl.toString(),
    source: 'ai',
    confidence: 'medium',
    logoUrl: faviconForDomain(domain),
  }
}

function candidateScore(c: ResolveCandidate): number {
  return CONFIDENCE_RANK[c.confidence] * 10 + (c.careerUrl ? 1 : 0)
}

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ candidates: [], error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = typeof (body as { name?: unknown })?.name === 'string' ? (body as { name: string }).name.trim() : ''
  if (!name) {
    return NextResponse.json({ candidates: [], error: 'name is required' }, { status: 400 })
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ candidates: [], error: 'name is too long' }, { status: 400 })
  }

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const candidates: ResolveCandidate[] = []

    // a. Known-companies reverse lookup — free, no network. For enterprises
    // whose ATS the probes below can't reach (Amazon, Google, Meta, Apple,
    // Microsoft, Netflix, Tesla, ...), known-companies.ts carries a
    // hand-curated careerUrl so the candidate isn't stuck at name/domain-only.
    const known = lookupKnownCompanyByName(name)
    if (known) {
      // Defensive: enforce the same "never a bare homepage" invariant as the
      // LLM path, even though known.careerUrl is hand-curated — guards against
      // a future known-companies.ts entry drifting to a root-path URL.
      let knownCareerUrl: string | null = null
      if (known.careerUrl) {
        try {
          knownCareerUrl = isBareHomepage(new URL(known.careerUrl)) ? null : known.careerUrl
        } catch {
          knownCareerUrl = null
        }
      }
      candidates.push({
        name: known.name,
        domain: known.domain,
        careerUrl: knownCareerUrl,
        source: 'known',
        confidence: 'high',
        logoUrl: faviconForDomain(known.domain),
      })
    }

    // b. Boards that exist under this name, described by what the provider says
    // they are. Skipped for a known company: its own board is found (and
    // verified) by the refresh, and a namesake's must not be offered.
    if (!known) {
      try {
        candidates.push(...(await findPossibleBoards(name)))
      } catch {
        /* none */
      }
    }

    // c. LLM fallback — only when a+b found nothing, and only when the user
    // has a key. Missing key => skip silently, never fail the request.
    if (!candidates.some((c) => c.source === 'known')) {
      try {
        const apiKeys = await loadApiKeys(supabase, user.id)
        if (apiKeys.openrouter) {
          const llmCandidate = await withTrace(createAdminClient(), user.id, { name: 'resolve-company', input: { name } }, () =>
            resolveWithLlm(apiKeys, name)
          )
          if (llmCandidate) candidates.push(llmCandidate)
        }
      } catch {
        // Best-effort fallback only — never fail the whole request over it.
      }
    }

    // De-dup by careerUrl, rank best-first, cap at MAX_CANDIDATES.
    const seenUrls = new Set<string>()
    const deduped = candidates.filter((c) => {
      if (!c.careerUrl) return true
      if (seenUrls.has(c.careerUrl)) return false
      seenUrls.add(c.careerUrl)
      return true
    })
    deduped.sort((a, b) => candidateScore(b) - candidateScore(a))

    return NextResponse.json({ candidates: deduped.slice(0, MAX_CANDIDATES) })
  } catch (error) {
    console.error('Company resolve error:', error)
    return NextResponse.json({ candidates: [], error: 'An unexpected error occurred.' }, { status: 500 })
  }
}
