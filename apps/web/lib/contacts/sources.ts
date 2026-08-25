// Contact sourcing — derive PLAUSIBLE people/contacts at a company for a role,
// working with or without external data sources.
//
// FREE PATH FIRST (works with NO external keys): every contact this module can
// find without a BYOK provider comes from data already in the product:
//   1. the company dossier (lib/dossier/*, READ-ONLY — this file only reads
//      dossier rows via getDossierByCompany, never writes one)
//   2. the job posting's own text — hiring-manager names and recruiting
//      addresses often appear verbatim
//   3. the user's OWN already-known contacts at this company — used ONLY to
//      learn the company's email-address PATTERN from a known-good example,
//      never as a source of new people
// BYOK providers (Hunter.io, Apollo.io — see ./providers/*) are pure opt-in
// enhancements layered on top; with no key configured they are silently
// skipped and the free path is the entire result.
//
// THE CENTRAL RULE, enforced structurally rather than just documented: nothing
// in this file ever sets `verified: true` except a BYOK provider that actually
// ran a deliverability check (Hunter's email-verifier). A name mention, a
// quoted posting email, and a pattern-guessed address are all `verified:
// false` however high their `confidence` — presenting an inferred address as
// confirmed is exactly the product defect this module is designed to avoid.
// Every candidate also carries `basis`, a short human-readable sentence
// explaining HOW it was derived — nothing here ever claims a fabricated
// shared history or a connection the candidate cannot actually support.
//
// PERSISTENCE NOTE: the `source`/`confidence`/`verified`/`basis` columns on
// public.contacts are added by supabase/migrations/20260728000007_contact_
// provenance.sql, which this workstream WROTE but does not apply (the
// orchestrator applies migrations). Every DB read/write below therefore
// probes column availability once (see contactsHasProvenanceColumns) and
// degrades to the pre-migration column set rather than erroring — the exact
// same "never crash, degrade honestly" pattern this codebase already uses for
// a missing LLM key (see lib/dossier/store.ts's MissingSummaryReason). The
// in-memory `candidates[]` returned by sourceContactsForCompany ALWAYS carries
// full provenance regardless of migration state — only the persisted row is
// affected.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeDomain } from '@/lib/dossier/sources'
import { getDossierByCompany } from '@/lib/dossier/store'
import { hunterDomainSearch, hunterEmailFinder, hunterVerifyEmail } from './providers/hunter'
import { apolloPeopleSearch } from './providers/apollo'

// --- Types --------------------------------------------------------------

export type ContactSource = 'dossier' | 'posting' | 'pattern' | 'hunter' | 'apollo'

export interface ContactCandidate {
  name: string | null
  email: string | null
  title: string | null
  linkedinUrl: string | null
  source: ContactSource
  /** 0..1 — how much to trust this candidate. Never a hard claim. */
  confidence: number
  /**
   * TRUE only when a provider affirmatively confirmed deliverability. Every
   * other path — including a directly-quoted posting email or a pattern
   * match — is verified=false, however high its confidence.
   */
  verified: boolean
  /** Short, human-readable provenance shown to the user. Never fabricated. */
  basis: string
}

// --- Small text helpers ---------------------------------------------------

/** Trim/collapse a captured title fragment; reject junk that's too short/long. */
function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '')
  if (cleaned.length < 3 || cleaned.length > 60) return null
  return cleaned
}

// Common capitalized words that regularly sit where a name would in job-
// posting prose (locations, department names, EEO boilerplate) — a captured
// "name" containing any of these is almost never an actual person.
const NON_NAME_TOKENS = new Set([
  'Team', 'Department', 'Office', 'Company', 'Group', 'Organization', 'Engineering', 'Product', 'Design',
  'Marketing', 'Sales', 'Operations', 'Finance', 'Legal', 'People', 'Talent', 'Recruiting', 'Recruitment',
  'America', 'Europe', 'Asia', 'Remote', 'Hybrid', 'Full', 'Part', 'Time', 'United', 'States', 'Kingdom',
  'City', 'San', 'Francisco', 'New', 'York', 'Los', 'Angeles', 'North', 'South', 'East', 'West', 'Coast',
  'Equal', 'Opportunity', 'Employer', 'Diversity', 'Inclusion', 'Benefits', 'Compensation', 'Base', 'Range',
  'Our', 'The', 'This', 'We', 'You', 'Your',
])

function isPlausiblePersonName(name: string): boolean {
  const tokens = name.split(/\s+/).filter(Boolean)
  if (tokens.length < 2 || tokens.length > 3) return false
  if (tokens.some((t) => NON_NAME_TOKENS.has(t))) return false
  if (tokens.some((t) => t.length < 2)) return false
  return true
}

const ROLE_HINT_RE =
  /\b(manager|director|lead|head|officer|president|founder|ceo|cto|coo|cfo|vp|vice president|engineer(?:ing)?|recruiter|recruiting|talent|human resources|chief|hiring)\b/i

const NAME_ONLY_RE = /^\s*([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})/
const TITLE_TAIL_RE = /^\s*,\s*(?:our|the)?\s*([A-Za-z][\w /&-]{2,50}?)(?=[.,;\n]|$)/

/** Given text starting right after a trigger keyword, pull a name + optional trailing title. */
function matchNameAndOptionalTitle(windowText: string): { name: string; title: string | null } | null {
  const nm = NAME_ONLY_RE.exec(windowText)
  if (!nm) return null
  const name = nm[1].trim()
  let title: string | null = null
  const rest = windowText.slice(nm[0].length)
  const tm = TITLE_TAIL_RE.exec(rest)
  if (tm) title = cleanTitle(tm[1])
  return { name, title }
}

interface KeywordMentionSpec {
  keywords: string[]
  defaultTitle: string | null
  confidence: number
}

// Case-insensitive keyword lookup done via string search (not a regex /i/
// flag) so the CAPITALIZATION requirement inside NAME_ONLY_RE never gets
// silently defeated by the flag applying to the whole pattern.
const KEYWORD_MENTIONS: KeywordMentionSpec[] = [
  { keywords: ['reports to', 'report directly to', 'reporting to'], defaultTitle: null, confidence: 0.5 },
  { keywords: ['hiring manager is', 'hiring manager:', 'hiring manager -'], defaultTitle: 'Hiring manager', confidence: 0.55 },
  { keywords: ['point of contact:', 'point of contact is'], defaultTitle: 'Point of contact', confidence: 0.45 },
  { keywords: ['reach out to'], defaultTitle: null, confidence: 0.4 },
  { keywords: ['founded by', 'co-founded by'], defaultTitle: 'Founder / leadership', confidence: 0.4 },
  { keywords: ['statement from', 'statement by'], defaultTitle: 'Company spokesperson (per news headline)', confidence: 0.35 },
]

function extractKeywordMentions(text: string): { name: string; title: string | null; confidence: number }[] {
  const lower = text.toLowerCase()
  const out: { name: string; title: string | null; confidence: number }[] = []
  for (const spec of KEYWORD_MENTIONS) {
    for (const kw of spec.keywords) {
      let idx = lower.indexOf(kw)
      while (idx !== -1) {
        const start = idx + kw.length
        const window = text.slice(start, start + 90)
        const hit = matchNameAndOptionalTitle(window)
        if (hit) out.push({ name: hit.name, title: hit.title ?? spec.defaultTitle, confidence: spec.confidence })
        idx = lower.indexOf(kw, idx + kw.length)
      }
    }
  }
  return out
}

// "Jane Doe, our Head of Engineering" — name FIRST, title after. Not anchored
// to a keyword, so it's gated by ROLE_HINT_RE on the captured title to avoid
// matching "San Francisco, our headquarters"-shaped false positives.
const NAME_THEN_TITLE_RE =
  /\b([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2}),\s+(?:our|the)?\s*([A-Za-z][\w /&-]{2,50}?)(?=[.,;\n]|$)/g

function extractNameThenTitle(text: string): { name: string; title: string | null; confidence: number }[] {
  const out: { name: string; title: string | null; confidence: number }[] = []
  NAME_THEN_TITLE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NAME_THEN_TITLE_RE.exec(text))) {
    const rawTitle = cleanTitle(m[2])
    if (!rawTitle || !ROLE_HINT_RE.test(rawTitle)) continue
    out.push({ name: m[1].trim(), title: rawTitle, confidence: 0.45 })
  }
  return out
}

const MAX_SCAN_CHARS = 8000

/**
 * Best-effort, deliberately conservative name/title extraction from free-form
 * prose (dossier text or a job posting). Heuristic and low-confidence by
 * design — every hit is capped well below anything a provider or a directly-
 * quoted email earns, and `isPlausiblePersonName` throws out the common
 * location/department/EEO-boilerplate false positives.
 */
function extractNamedMentions(text: string, source: 'dossier' | 'posting'): ContactCandidate[] {
  if (!text || !text.trim()) return []
  const clipped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  const raw = [...extractKeywordMentions(clipped), ...extractNameThenTitle(clipped)]
  const out: ContactCandidate[] = []
  for (const hit of raw) {
    if (!isPlausiblePersonName(hit.name)) continue
    out.push({
      name: hit.name,
      email: null,
      title: hit.title,
      linkedinUrl: null,
      source,
      confidence: hit.confidence,
      verified: false,
      basis:
        `INFERRED from ${source === 'dossier' ? 'the company dossier' : 'the job posting'} text — a name ` +
        `mention near ${hit.title ? `"${hit.title}"` : 'a contact/leadership reference'}, not independently confirmed.`,
    })
  }
  return dedupeCandidates(out)
}

// --- Email extraction from posting text -----------------------------------

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Recruiting-flavored role aliases: not a named individual, but a real,
// useful outreach channel — surfaced as a general contact, never as a person.
const GENERAL_ALIASES = new Set(['careers', 'career', 'recruiting', 'recruitment', 'talent', 'hiring', 'jobs', 'apply', 'people', 'hr', 'team'])
// Role aliases that are NOT relevant to job outreach (ADA/legal/support/etc.)
// — excluded outright rather than surfaced as noise.
const EXCLUDED_ALIASES = new Set([
  'accommodations', 'ada', 'accessibility', 'privacy', 'legal', 'security', 'abuse', 'support', 'billing',
  'press', 'media', 'info', 'admin', 'noreply', 'no-reply', 'webmaster', 'postmaster', 'unsubscribe', 'help',
  'contact', 'sales', 'marketing', 'hello', 'compliance', 'trust', 'safety', 'dpo', 'gdpr', 'finance',
])
// "jane.doe" / "j.doe" / "jane_doe" — looks like it maps to a real name.
const PERSON_LOCAL_RE = /^[a-z]+([._-][a-z]+)+$/

function classifyPostingEmail(
  email: string
): { kind: 'person' | 'general'; displayName: string | null; title: string | null; confidence: number } | null {
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  const base = local.split('+')[0] // strip a +tag suffix (e.g. talent+hn)
  if (EXCLUDED_ALIASES.has(base)) return null
  if (GENERAL_ALIASES.has(base)) {
    return { kind: 'general', displayName: null, title: 'General recruiting/company contact', confidence: 0.55 }
  }
  if (PERSON_LOCAL_RE.test(base)) {
    const name = base
      .split(/[._-]/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(' ')
    return { kind: 'person', displayName: name || null, title: null, confidence: 0.7 }
  }
  return null // an ambiguous single-word alias not on either list — skip rather than guess
}

/** Named mentions + directly-quoted, domain-matching email addresses from one job posting's text. */
export function extractPostingCandidates(text: string, domain: string | null): ContactCandidate[] {
  if (!text) return []
  const out: ContactCandidate[] = extractNamedMentions(text, 'posting')

  const host = normalizeDomain(domain)
  if (host) {
    const clipped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
    const seen = new Set<string>()
    for (const m of clipped.matchAll(EMAIL_RE)) {
      const email = m[0].toLowerCase()
      if (seen.has(email)) continue
      seen.add(email)
      const emailHost = normalizeDomain(email.split('@')[1] ?? null)
      if (emailHost !== host) continue // never attribute a third-party email to this company
      const classified = classifyPostingEmail(email)
      if (!classified) continue
      out.push({
        name: classified.displayName,
        email,
        title: classified.title,
        linkedinUrl: null,
        source: 'posting',
        confidence: classified.confidence,
        verified: false,
        basis:
          classified.kind === 'person'
            ? `Email address published directly in the job posting text at ${host} — the address itself is real, but who it belongs to is a guess from the local part.`
            : `General recruiting/company inbox published directly in the job posting text at ${host}.`,
      })
    }
  }
  return dedupeCandidates(out)
}

// --- Dossier text extraction -----------------------------------------------

export interface DossierTextInput {
  summary?: string | null
  culture?: string | null
  whatTheyWant?: string | null
  funding?: string | null
  headcountTrend?: string | null
  /** dossier.sources[].title — news headlines etc. sometimes name a person. */
  sourceTitles?: string[]
}

/** Named mentions from the company dossier's synthesized text + source headlines. Never touches the dossier row. */
export function extractDossierCandidates(input: DossierTextInput): ContactCandidate[] {
  const blocks = [input.summary, input.culture, input.whatTheyWant, input.funding, input.headcountTrend, ...(input.sourceTitles ?? [])].filter(
    (s): s is string => !!s && s.trim().length > 0
  )
  const out: ContactCandidate[] = []
  for (const block of blocks) out.push(...extractNamedMentions(block, 'dossier'))
  return dedupeCandidates(out)
}

// --- Pattern inference -------------------------------------------------------

export interface KnownGoodContact {
  name: string
  email: string
}

interface EmailPattern {
  template: string
  domain: string
  exampleEmail: string
}

function tokenizeName(name: string): { first: string; last: string } | null {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean)
  if (parts.length < 2) return null
  return { first: parts[0], last: parts[parts.length - 1] }
}

/** Compare a known-good (name, email) pair against the common enterprise address templates. */
function detectPattern(name: string, email: string, domain: string): EmailPattern | null {
  const local = email.split('@')[0]?.toLowerCase()
  const emailDomain = normalizeDomain(email.split('@')[1] ?? null)
  if (!local || !emailDomain || emailDomain !== normalizeDomain(domain)) return null
  const tok = tokenizeName(name)
  if (!tok) return null
  const { first, last } = tok
  if (!first || !last) return null
  const fi = first[0]
  const li = last[0]
  const candidates: [string, string][] = [
    [`${first}.${last}`, '{first}.{last}'],
    [`${first}_${last}`, '{first}_{last}'],
    [`${first}${last}`, '{first}{last}'],
    [`${fi}${last}`, '{f}{last}'],
    [`${fi}.${last}`, '{f}.{last}'],
    [`${first}${li}`, '{first}{l}'],
    [`${first}.${li}`, '{first}.{l}'],
    [`${last}.${first}`, '{last}.{first}'],
    [`${last}${first}`, '{last}{first}'],
    [`${fi}${li}`, '{f}{l}'],
    [first, '{first}'],
    [last, '{last}'],
  ]
  for (const [candidate, template] of candidates) {
    if (candidate === local) return { template, domain: emailDomain, exampleEmail: email }
  }
  return null
}

function applyPattern(pattern: EmailPattern, name: string): string | null {
  const tok = tokenizeName(name)
  if (!tok) return null
  const { first, last } = tok
  let local = pattern.template
    .split('{first}').join(first)
    .split('{last}').join(last)
    .split('{f}').join(first[0] ?? '')
    .split('{l}').join(last[0] ?? '')
  local = local.trim()
  if (!local) return null
  return `${local}@${pattern.domain}`
}

/**
 * Learn an email-address pattern from ANY known-good (name, email) pair at
 * this domain, then apply it to fill in an address for name-only candidates.
 * Returns [] when no known-good example exists — this module never fabricates
 * a pattern out of thin air, only from real evidence already in the product.
 */
export function inferPatternCandidates(
  nameOnlyCandidates: ContactCandidate[],
  knownGood: KnownGoodContact[],
  domain: string
): ContactCandidate[] {
  const host = normalizeDomain(domain)
  if (!host) return []
  let pattern: EmailPattern | null = null
  for (const kg of knownGood) {
    const p = detectPattern(kg.name, kg.email, host)
    if (p) {
      pattern = p
      break
    }
  }
  if (!pattern) return []
  const out: ContactCandidate[] = []
  for (const cand of nameOnlyCandidates) {
    if (cand.email || !cand.name) continue
    const email = applyPattern(pattern, cand.name)
    if (!email) continue
    out.push({
      ...cand,
      email,
      source: 'pattern',
      confidence: Math.min(cand.confidence, 0.5),
      verified: false,
      basis:
        `INFERRED, NOT VERIFIED: applied the "${pattern.template}" address pattern (learned from the known-good ` +
        `address ${pattern.exampleEmail}) to ${cand.name}. Confirm before relying on it.`,
    })
  }
  return out
}

// --- Ranking / dedupe ----------------------------------------------------

function rank(c: ContactCandidate): number {
  return (c.verified ? 10 : 0) + c.confidence
}

export function dedupeCandidates(cands: ContactCandidate[]): ContactCandidate[] {
  const byKey = new Map<string, ContactCandidate>()
  for (const c of cands) {
    if (!c.email && !c.name) continue
    const key = c.email ? `email:${c.email.toLowerCase()}` : `name:${(c.name as string).toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing || rank(c) > rank(existing)) byKey.set(key, c)
  }
  return [...byKey.values()]
}

// --- Orchestrator ------------------------------------------------------------

export interface ProviderOutcome {
  provider: 'hunter' | 'apollo'
  ran: boolean
  /** Set whenever ran=false — always a clear, honest reason, never a silent gap. */
  reason?: 'no-key' | 'no-domain' | 'error'
  found: number
}

export interface SourceContactsParams {
  /** Service-role (admin) client — this function explicitly scopes every query by userId itself. */
  client: SupabaseClient
  userId: string
  companyId: string
  /** Scope posting-text extraction to one job; omit to scan the company's most recent postings. */
  jobId?: string | null
  hunterKey?: string | null
  apolloKey?: string | null
  /** Cap on candidates persisted as new contacts rows (default 10, max 25). */
  limit?: number
  signal?: AbortSignal
}

export interface SourceContactsResult {
  companyId: string
  companyName: string
  domain: string | null
  jobId: string | null
  /** Every scored candidate, ranked best-first — ALWAYS carries full provenance, independent of DB migration state. */
  candidates: ContactCandidate[]
  inserted: { id: string; name: string; email: string | null; source: ContactSource }[]
  skippedExisting: number
  providers: ProviderOutcome[]
  freePathOnly: boolean
  /** False when supabase/migrations/20260728000007_contact_provenance.sql has not been applied yet — see this file's header. */
  provenanceColumnsAvailable: boolean
}

const JOBS_SCAN_LIMIT = 5
const MAX_HUNTER_FINDER_LOOKUPS = 3

let provenanceColumnsCache: { value: boolean; checkedAt: number } | null = null
// Short TTL, not "forever": a long-lived dev server / warm serverless
// instance must notice within a few minutes once the orchestrator applies
// the migration, without needing a process restart.
const PROVENANCE_CACHE_TTL_MS = 5 * 60 * 1000

/** Cheap, briefly-cached probe for whether the migration above has landed. */
async function contactsHasProvenanceColumns(client: SupabaseClient): Promise<boolean> {
  const now = Date.now()
  if (provenanceColumnsCache && now - provenanceColumnsCache.checkedAt < PROVENANCE_CACHE_TTL_MS) {
    return provenanceColumnsCache.value
  }
  const { error } = await client.from('contacts').select('source').limit(1)
  const value = !error
  provenanceColumnsCache = { value, checkedAt: now }
  return value
}

interface CompanyRow {
  id: string
  name: string
  domain: string | null
}
interface ExistingContactRow {
  id: string
  name: string
  email: string | null
  title: string | null
}

export async function sourceContactsForCompany(params: SourceContactsParams): Promise<SourceContactsResult> {
  const { client, userId, companyId, jobId, hunterKey, apolloKey, signal } = params
  const limit = Math.max(1, Math.min(25, params.limit ?? 10))

  const { data: companyData } = await client
    .from('companies')
    .select('id, name, domain')
    .eq('id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  const company = companyData as CompanyRow | null
  if (!company) throw new Error('Company not found (or not owned by this user)')
  const domain = normalizeDomain(company.domain)

  // 1) Posting text — either one specific job, or this company's most recent.
  const postingTexts: { jobId: string; text: string }[] = []
  if (jobId) {
    const { data: job } = await client.from('jobs').select('id, description, company_id').eq('id', jobId).maybeSingle()
    const j = job as { id: string; description: string | null; company_id: string } | null
    if (j && j.company_id === companyId && j.description) postingTexts.push({ jobId: j.id, text: j.description })
  } else {
    const { data: jobs } = await client
      .from('jobs')
      .select('id, description')
      .eq('company_id', companyId)
      .order('discovered_at', { ascending: false })
      .limit(JOBS_SCAN_LIMIT)
    for (const j of (jobs as { id: string; description: string | null }[] | null) ?? []) {
      if (j.description) postingTexts.push({ jobId: j.id, text: j.description })
    }
  }

  // 2) Dossier (READ-ONLY).
  const dossier = await getDossierByCompany(client, userId, companyId)

  // 3) Existing contacts at this company — for dedupe AND as pattern anchors.
  const hasProvenance = await contactsHasProvenanceColumns(client)
  const existingSelect = hasProvenance ? 'id, name, email, title, source, confidence, verified' : 'id, name, email, title'
  const { data: existingRows } = await client.from('contacts').select(existingSelect).eq('user_id', userId).eq('company_id', companyId)
  const existing = (existingRows as ExistingContactRow[] | null) ?? []
  const existingEmails = new Set(existing.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e))
  const existingNames = new Set(existing.map((c) => c.name?.toLowerCase()).filter((n): n is string => !!n))

  // --- FREE PATH ---
  const dossierCandidates = dossier
    ? extractDossierCandidates({
        summary: dossier.summary,
        culture: dossier.signals?.culture ?? null,
        whatTheyWant: dossier.signals?.whatTheyWant ?? null,
        funding: dossier.signals?.funding ?? null,
        headcountTrend: dossier.signals?.headcountTrend ?? null,
        sourceTitles: (dossier.sources ?? []).map((s) => s.title),
      })
    : []

  const postingCandidates: ContactCandidate[] = []
  for (const p of postingTexts) postingCandidates.push(...extractPostingCandidates(p.text, domain))

  const knownGood: KnownGoodContact[] = existing
    .filter((c): c is ExistingContactRow & { email: string } => !!c.email && !!c.name)
    .map((c) => ({ name: c.name, email: c.email }))
  for (const c of postingCandidates) {
    if (c.email && c.name && c.source === 'posting') knownGood.push({ name: c.name, email: c.email })
  }

  let nameOnly = [...dossierCandidates, ...postingCandidates].filter((c) => c.name && !c.email)

  // --- BYOK: Hunter (domain search, then email-finder for leftover names, then verifier on the top pattern guess) ---
  const providers: ProviderOutcome[] = []
  let hunterCandidates: ContactCandidate[] = []
  if (!hunterKey) {
    providers.push({ provider: 'hunter', ran: false, reason: 'no-key', found: 0 })
  } else if (!domain) {
    providers.push({ provider: 'hunter', ran: false, reason: 'no-domain', found: 0 })
  } else {
    try {
      hunterCandidates = await hunterDomainSearch({ apiKey: hunterKey, domain, limit: 10, timeoutMs: 8000 })
      providers.push({ provider: 'hunter', ran: true, found: hunterCandidates.length })
    } catch {
      providers.push({ provider: 'hunter', ran: false, reason: 'error', found: 0 })
    }

    // Resolve a bounded number of remaining name-only mentions via Hunter's
    // own email-finder before falling back to our own pattern guess.
    const resolvedNames = new Set<string>()
    for (const target of nameOnly.slice(0, MAX_HUNTER_FINDER_LOOKUPS)) {
      if (!target.name || signal?.aborted) break
      try {
        const found = await hunterEmailFinder({ apiKey: hunterKey, domain, name: target.name, timeoutMs: 6000 })
        if (found) {
          hunterCandidates.push({
            ...found,
            title: target.title ?? found.title,
            basis: `Name mentioned in ${target.source === 'dossier' ? 'the company dossier' : 'the job posting'}; email resolved via Hunter.io's email finder for "${target.name}" at ${domain}.`,
          })
          resolvedNames.add(target.name.toLowerCase())
        }
      } catch {
        // isolated — one finder miss never blocks the rest of the pipeline
      }
    }
    nameOnly = nameOnly.filter((c) => !c.name || !resolvedNames.has(c.name.toLowerCase()))
  }

  // --- BYOK: Apollo people search ---
  let apolloCandidates: ContactCandidate[] = []
  if (!apolloKey) {
    providers.push({ provider: 'apollo', ran: false, reason: 'no-key', found: 0 })
  } else if (!domain) {
    providers.push({ provider: 'apollo', ran: false, reason: 'no-domain', found: 0 })
  } else {
    try {
      apolloCandidates = await apolloPeopleSearch({ apiKey: apolloKey, domain, companyName: company.name, limit: 10, timeoutMs: 8000 })
      providers.push({ provider: 'apollo', ran: true, found: apolloCandidates.length })
    } catch {
      providers.push({ provider: 'apollo', ran: false, reason: 'error', found: 0 })
    }
  }

  // --- Pattern fallback for whatever names remain unresolved ---
  const patternCandidates = domain ? inferPatternCandidates(nameOnly, knownGood, domain) : []

  // A Hunter key lets us CHECK (not just guess) the single best pattern
  // candidate: confirmed-bad gets dropped, confirmed-good gets verified=true.
  if (hunterKey && domain && patternCandidates.length > 0) {
    const top = patternCandidates[0]
    if (top.email) {
      try {
        const verdict = await hunterVerifyEmail({ apiKey: hunterKey, email: top.email, timeoutMs: 6000 })
        if (verdict?.status === 'undeliverable') {
          patternCandidates.splice(0, 1)
        } else if (verdict?.status === 'deliverable') {
          top.verified = true
          top.confidence = Math.max(top.confidence, 0.85)
          top.basis += " Confirmed deliverable by Hunter.io's email verifier."
        }
      } catch {
        // verifier failure — leave the unverified guess exactly as it was
      }
    }
  }

  let candidates = dedupeCandidates([...dossierCandidates, ...postingCandidates, ...patternCandidates, ...hunterCandidates, ...apolloCandidates])
  candidates.sort((a, b) => rank(b) - rank(a) || (b.email ? 1 : 0) - (a.email ? 1 : 0))
  candidates = candidates.slice(0, limit)

  // --- Persist: skip anything already known, insert the rest ---
  const inserted: SourceContactsResult['inserted'] = []
  let skippedExisting = 0
  for (const c of candidates) {
    const dup = c.email ? existingEmails.has(c.email.toLowerCase()) : c.name ? existingNames.has(c.name.toLowerCase()) : false
    if (dup) {
      skippedExisting++
      continue
    }
    if (!c.name && !c.email) continue

    const displayName = c.name || (c.email ? c.email.split('@')[0] : 'Unknown contact')
    const insertRow: Record<string, unknown> = {
      user_id: userId,
      company_id: companyId,
      name: displayName,
      email: c.email,
      title: c.title,
      relationship: 'sourced',
      notes: hasProvenance
        ? c.basis
        : `${c.basis} [provenance columns pending migration: source=${c.source} confidence=${c.confidence.toFixed(2)} verified=${c.verified}]`,
    }
    if (hasProvenance) {
      insertRow.source = c.source
      insertRow.confidence = c.confidence
      insertRow.verified = c.verified
      insertRow.basis = c.basis
    }

    const { data: row, error } = await client.from('contacts').insert(insertRow).select('id, name, email').single()
    if (error || !row) continue
    const inserted_row = row as { id: string; name: string; email: string | null }
    inserted.push({ id: inserted_row.id, name: inserted_row.name, email: inserted_row.email, source: c.source })
    if (c.email) existingEmails.add(c.email.toLowerCase())
    if (c.name) existingNames.add(c.name.toLowerCase())
  }

  return {
    companyId,
    companyName: company.name,
    domain,
    jobId: jobId ?? null,
    candidates,
    inserted,
    skippedExisting,
    providers,
    freePathOnly: !hunterKey && !apolloKey,
    provenanceColumnsAvailable: hasProvenance,
  }
}
