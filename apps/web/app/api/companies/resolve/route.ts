import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadApiKeys } from '@/lib/harness/keys'
import { callLlm, parseJsonLoose, MissingKeyError } from '@/lib/harness/llm'
import type { DecryptedApiKeys } from '@/lib/harness/types'
import { fetchJson, assertAllowedHost } from '@/lib/ats/http'
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
//   b. Probe Greenhouse/Lever/Ashby boards  — network, ~5s timeout each, all
//      candidate slugs × providers run in parallel. A 200 with a plausible
//      payload is a real, verified career board.
//   c. LLM fallback                         — ONLY when a+b found nothing AND
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
type Source = 'known' | 'greenhouse' | 'lever' | 'ashby' | 'ai'

export interface ResolveCandidate {
  name: string
  domain: string | null
  careerUrl: string | null
  source: Source
  confidence: Confidence
  logoUrl?: string
}

const PROBE_TIMEOUT_MS = 5000
const MAX_CANDIDATES = 5
const MAX_SLUGS = 4
const MAX_NAME_LENGTH = 200

const GREENHOUSE_HOSTS = new Set(['boards-api.greenhouse.io'])
const LEVER_HOSTS = new Set(['api.lever.co'])
const ASHBY_HOSTS = new Set(['api.ashbyhq.com'])

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

interface ProbeHit {
  source: 'greenhouse' | 'lever' | 'ashby'
  slug: string
  careerUrl: string
}

/** Cheap existence probes — lighter payloads than the full refresh fetch in lib/ats/*. */
async function probeGreenhouse(slug: string): Promise<boolean> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`
    assertAllowedHost(url, GREENHOUSE_HOSTS)
    const json = await fetchJson<{ jobs?: unknown }>(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return Array.isArray(json?.jobs)
  } catch {
    return false
  }
}

async function probeLever(slug: string): Promise<boolean> {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`
    assertAllowedHost(url, LEVER_HOSTS)
    const json = await fetchJson<unknown>(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return Array.isArray(json)
  } catch {
    return false
  }
}

async function probeAshby(slug: string): Promise<boolean> {
  try {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`
    assertAllowedHost(url, ASHBY_HOSTS)
    const json = await fetchJson<{ jobs?: unknown }>(url, { timeoutMs: PROBE_TIMEOUT_MS })
    return Array.isArray(json?.jobs)
  } catch {
    return false
  }
}

/** Probe every provider × slug combination in parallel. Never throws. */
async function probeAllAts(name: string, domain?: string | null): Promise<ProbeHit[]> {
  const slugs = slugCandidates(name, domain)
  if (slugs.length === 0) return []

  const tasks: Promise<ProbeHit | null>[] = []
  for (const slug of slugs) {
    tasks.push(
      probeGreenhouse(slug).then((ok) =>
        ok ? { source: 'greenhouse' as const, slug, careerUrl: `https://boards.greenhouse.io/${slug}` } : null
      )
    )
    tasks.push(
      probeLever(slug).then((ok) =>
        ok ? { source: 'lever' as const, slug, careerUrl: `https://jobs.lever.co/${slug}` } : null
      )
    )
    tasks.push(
      probeAshby(slug).then((ok) =>
        ok ? { source: 'ashby' as const, slug, careerUrl: `https://jobs.ashbyhq.com/${slug}` } : null
      )
    )
  }

  const settled = await Promise.allSettled(tasks)
  const hits: ProbeHit[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) hits.push(r.value)
  }
  return hits
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

    // b. ATS probes — network, parallel, ~5s timeout each. Never throws.
    let atsHits: ProbeHit[] = []
    try {
      atsHits = await probeAllAts(name, known?.domain ?? null)
    } catch {
      atsHits = []
    }
    for (const hit of atsHits) {
      candidates.push({
        name: known?.name ?? name,
        domain: known?.domain ?? null,
        careerUrl: hit.careerUrl,
        source: hit.source,
        confidence: 'high',
        logoUrl: known ? faviconForDomain(known.domain) : undefined,
      })
    }

    // c. LLM fallback — only when a+b found nothing, and only when the user
    // has a key. Missing key => skip silently, never fail the request.
    if (candidates.length === 0) {
      try {
        const apiKeys = await loadApiKeys(supabase, user.id)
        if (apiKeys.openrouter) {
          const llmCandidate = await resolveWithLlm(apiKeys, name)
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
