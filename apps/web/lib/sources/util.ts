// Shared helpers for source adapters: HTTP (reuses lib/ats transport), HTML
// stripping, keyword relevance, and URL/domain extraction. Framework-free —
// relative imports only, same rule as lib/ats/*.

import { assertAllowedHost, fetchJson, type FetchJsonOptions } from '../ats/http'
import { classifyJob, isLowQuality, type Classification } from '../jobs/classify'
import { repairMojibake } from '../jobs/mojibake'
import type { Targeting } from '../targeting'
import type { JobLead, SourceQuery } from './types'

/**
 * GET JSON from a vetted host. Combines the SSRF host-allowlist with the shared
 * retry/backoff/timeout transport from lib/ats (which also blocks redirects).
 */
export async function getJson<T = unknown>(
  url: string,
  allowedHosts: ReadonlySet<string>,
  opts: FetchJsonOptions = {}
): Promise<T> {
  assertAllowedHost(url, allowedHosts)
  return fetchJson<T>(url, { retries: 2, timeoutMs: 15_000, ...opts })
}

/** Strip HTML tags + decode a handful of common entities → collapsed plain text.
 *
 *  Also repairs mojibake, and this is the load-bearing place to do it.
 *
 *  A real job description shown to the user read "9:00 AM â 6:00 PM" and
 *  "Â·  Design, build and maintain" — UTF-8 bytes that some upstream board
 *  served, or stored, as Latin-1. A survey of the live table found 106 corrupted
 *  rows and every one of them came in through a lib/sources adapter (all
 *  source='remoteok'), NOT through lib/ats: the Greenhouse/Lever/Ashby path had
 *  zero. So repairing inside the ATS layer fixes nothing a user would ever see.
 *
 *  Every board adapter funnels its text through here, which makes this the one
 *  seam that covers all of them at once. repairMojibake is conservative by
 *  construction — it only rewrites text carrying the mojibake signature and
 *  leaves correct text (including legitimate "â"/"Â") untouched, so applying it
 *  to everything is safe. See lib/jobs/mojibake.ts. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return ''
  return repairMojibake(input)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Truncate to a max length on a word boundary. */
export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

/** Personal/aggregator hosts that are never an employer's own domain. */
// EVERY HOST ANY SOURCE ADAPTER FETCHES FROM MUST APPEAR HERE.
//
// This list decides whether a URL yields an EMPLOYER's domain. When an
// aggregator's host is missing, employerDomainFromUrl() happily returns it, and
// ingestLeads stores it as the company's own domain. The damage is not
// cosmetic:
//   * ATS detection then probes the aggregator forever — it can never find the
//     employer's board, so the company returns zero jobs on every refresh;
//   * company dedupe collapses, because dozens of unrelated employers share one
//     domain;
//   * and email inference would synthesize addresses at the AGGREGATOR — a
//     Capital One contact reached at @themuse.com, which is both wrong and the
//     kind of invented address that must never go near outreach.
//
// MEASURED in the live table: 190 of one user's 436 companies carry an
// aggregator domain. "Capital One" is stored with domain themuse.com and
// "ManTech" with jobicy.com. Some of that is legacy, but five adapters shipped
// AFTER this list was last updated — himalayas.app, jobicy.com,
// weworkremotely.com, remotive.com and workingnomads.com were all absent, so
// those were still writing bad domains today.
//
// The failure mode is a hand-maintained list drifting from a growing adapter
// registry, so the fix is to stop maintaining it by hand: SOURCE_FETCH_HOSTS
// below is the union of what the adapters actually fetch, and a test in
// util.test.ts fails if an adapter host is missing from it. Adding a
// thirteenth adapter cannot silently reintroduce this.
export const SOURCE_FETCH_HOSTS = [
  'themuse.com',
  'arbeitnow.com',
  'remoteok.com',
  'remoteok.io',
  'himalayas.app',
  'jobicy.com',
  'weworkremotely.com',
  'remotive.com',
  'workingnomads.com',
  'echojobs.io',
  'hn.algolia.com',
  'yc-oss.github.io',
] as const

const NON_EMPLOYER_HOSTS = new Set([
  ...SOURCE_FETCH_HOSTS,
  ...SOURCE_FETCH_HOSTS.map((h) => `www.${h}`),
  'news.ycombinator.com',
  'ycombinator.com',
  'www.ycombinator.com',
  'workatastartup.com',
  'www.workatastartup.com',
  'lever.co',
  'greenhouse.io',
  'ashbyhq.com',
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'github.com',
  'gmail.com',
  'google.com',
])

/** Extract a registrable-ish employer domain from a URL, or null if it looks like an aggregator. */
export function employerDomainFromUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  let host: string
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
  if (!host) return null
  const full = 'www.' + host
  if (NON_EMPLOYER_HOSTS.has(host) || NON_EMPLOYER_HOSTS.has(full)) return null
  // Skip obvious code/social hosts that slip through subdomains.
  if (/(?:^|\.)(?:linkedin|twitter|github|greenhouse|lever|ashbyhq)\./.test(host)) return null
  return host
}

/** First absolute http(s) URL found in a block of text. */
export function firstUrlIn(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>()"']+/i)
  if (!m) return null
  // Trim trailing punctuation that commonly clings to inline URLs.
  return m[0].replace(/[.,;:)\]]+$/, '')
}

/** Escape a keyword for safe interpolation into a RegExp source string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a keyword into a matcher tested against lowercased haystack text.
 * Ported from career-ops scan.mjs:80-105 (compileKeyword/buildTitleFilter): a
 * short (2-3 char) ALL-ALPHA keyword ("ai", "ml", "sdr", "go") is treated as
 * an acronym and matched on WORD BOUNDARIES ONLY, so "ML" cannot match inside
 * "HTML5" and "go" cannot match inside "chicago"/"mango"/"algorithm". Any
 * longer keyword, or one containing non-letters (".NET", "C++", "full-stack"),
 * keeps fast, permissive SUBSTRING matching instead of `\b`-wrapping it: a
 * `\b` assertion requires a word-char/non-word-char transition, which is
 * unreliable right at a keyword's own punctuation (e.g. no boundary exists
 * between a preceding space and a leading "." in ".NET", so `\b\.NET\b`
 * silently fails to match text that plainly contains ".NET") — and a longer
 * string is unlikely to produce a false-positive substring match anyway.
 */
export function compileKeyword(keyword: string): (haystackLower: string) => boolean {
  const kw = keyword.toLowerCase()
  if (/^[a-z]{2,3}$/.test(kw)) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i')
    return (haystackLower) => re.test(haystackLower)
  }
  return (haystackLower) => haystackLower.includes(kw)
}

/**
 * Relevance score = weighted keyword hits using compileKeyword() (word-
 * boundary for short acronyms, substring otherwise — see above), so
 * single/two/three-letter keywords like "go", "ai", "sdr" only match the real
 * token, never a substring of an unrelated word ("chicago", "chair",
 * "sdrawkcab"). A keyword found in the TITLE counts for far more than one
 * merely present in the description/tags — the title is what a human
 * actually judges relevance by.
 *
 * Returns 0 when the query has no keywords: there is no signal to score
 * against. Callers decide separately whether keyword-less leads survive (see
 * rankAndLimit) — this function no longer pretends "no keywords" means
 * "everything is relevant".
 */
export function relevanceScore(lead: JobLead, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const title = ` ${lead.title.toLowerCase()} `
  const rest = ` ${lead.company} ${lead.description} ${(lead.tags ?? []).join(' ')} `.toLowerCase()
  let score = 0
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase()
    if (!kw) continue
    const matches = compileKeyword(kw)
    if (matches(title)) score += 5
    else if (matches(rest)) score += 1
  }
  return score
}

/**
 * Rank leads by keyword relevance (desc) and take the top `limit`. With
 * keywords supplied, zero-hit leads are dropped. With NO keywords there is no
 * relevance signal to filter on, so source order is preserved instead of
 * dropping everything — but note this no longer means "ingest indiscriminately":
 * sanitizeLeads() already removed synthesized/garbage titles via the shared
 * quality classifier before leads ever reach here, and adapters that can
 * server-side filter (themuse category/location, arbeitnow's DE/EU gate) do so
 * via SourceQuery.targeting before calling this at all.
 */
export function rankAndLimit(leads: JobLead[], q: SourceQuery): JobLead[] {
  const scored = leads.map((lead) => ({ lead, score: relevanceScore(lead, q.keywords) }))
  const filtered = q.keywords.length > 0 ? scored.filter((s) => s.score > 0) : scored
  filtered.sort((a, b) => b.score - a.score)
  return filtered.slice(0, Math.max(0, q.limit)).map((s) => s.lead)
}

function classifyLead(lead: JobLead): Classification {
  return classifyJob({
    title: lead.title,
    description: lead.description,
    location: lead.location,
    companyName: lead.company,
  })
}

/**
 * True when the classified lead matches the user's targeting. Unknown
 * country/language never excludes a lead (an unparseable location is not
 * evidence the job is wrong, just evidence the classifier couldn't tell).
 * `targeting` absent/undefined means "no signal to check against" — keep.
 *
 * This exists as a CLIENT-SIDE backstop, not a replacement for a source's own
 * server-side filter (e.g. themuse's `category` param): live verification
 * showed TheMuse's own category tagging is noisy (e.g. a "Counterparty
 * Credit Risk Manager" posting came back tagged "Software Engineering"), so
 * the classifier's per-job title analysis catches what the source's
 * self-reported category missed.
 */
function matchesTargeting(c: Classification, targeting: Targeting | undefined): boolean {
  if (!targeting) return true
  if (targeting.functions.length > 0 && !targeting.functions.includes(c.jobFunction)) return false
  if (targeting.seniority.length > 0 && !targeting.seniority.includes(c.seniority)) return false
  if (targeting.countries.length > 0 && c.country && !targeting.countries.includes(c.country)) return false
  if (targeting.languages.length > 0 && c.language !== 'unknown' && !targeting.languages.includes(c.language)) return false
  if (targeting.remoteOnly && !c.isRemote) return false
  return true
}

/**
 * Keep only leads with a usable https/http URL, a title that survives the
 * shared quality classifier (not synthesized junk / nav text / a bare city or
 * department word), and — when `targeting` is supplied — a classification
 * that matches it; dedup by externalId/url. This is the one place every
 * adapter's output funnels through, so a garbage or off-target title from any
 * source (aggregator noise, not just the HTML scraper) never reaches the
 * database.
 */
export function sanitizeLeads(leads: JobLead[], targeting?: Targeting): JobLead[] {
  const seen = new Set<string>()
  const out: JobLead[] = []
  for (const lead of leads) {
    if (!lead || typeof lead.url !== 'string' || !lead.title?.trim()) continue
    let parsed: URL
    try {
      parsed = new URL(lead.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue
    const c = classifyLead(lead)
    if (c.rejectReason || isLowQuality(c)) continue
    if (!matchesTargeting(c, targeting)) continue
    const key = lead.externalId || lead.url
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...lead, externalId: key })
  }
  return out
}
