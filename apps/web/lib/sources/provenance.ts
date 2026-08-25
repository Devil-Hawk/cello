// Per-opportunity provenance — the typed, computed record that answers
// "where did this job come from, and how much can I trust it?"
//
// WHY THIS EXISTS (see docs/PRODUCT-VISION.md #17): 20,369 jobs are tracked
// against 446 "companies", but 138+ of those company rows are really
// arbeitnow.com / remoteok.com themselves (the aggregator's own domain got
// stored as the employer's domain — see ingestLeads in ./index.ts and
// employerDomainFromUrl in ./util.ts). 14,298 of 20,369 jobs have an empty
// description (structural for Greenhouse: its public board-list API returns
// title/url/location only, never the posting body — see lib/ats/greenhouse.ts).
// Only 115 of 20,369 are scored. Left unlabeled, a data-science resume gets
// scored against scraped sales/ops listings from a job board and nobody can
// tell why match quality is low. This module makes that visible per job.
//
// DERIVED, NOT STORED: employerClass / sourceKind / trustTier /
// descriptionComplete / autoApplySupported are all computed at read time from
// columns that already exist (jobs.source, jobs.url, jobs.description,
// companies.domain, companies.metadata). Nothing here is persisted.
//
// THE TWO FIELDS THAT GENUINELY CANNOT BE DERIVED: "last verified" and "still
// open". Traced in lib/ats/index.ts refreshCompany(): a refresh only INSERTS
// jobs that are new (`existing.has(job.externalId)` rows are left completely
// untouched — "preserves discovered_at/is_new/match data", see that file's
// docstring) and never marks a job absent from a fresh fetch as closed. So for
// the 20,369 rows in this database today there is no signal beyond
// `discovered_at` for "when did we last see this posting alive" — that is an
// honest gap, not a bug to paper over. supabase/migrations/
// 20260728000008_job_provenance.sql adds jobs.last_verified_at / jobs.
// still_open (nullable, unpopulated by that migration) as the seam a future
// reverification pass writes into; computeJobProvenance() reads them when
// present and reports `basis: 'unknown'` honestly when they are not.
//
// Framework-free (no next/*, no path aliases) so this can be called from a
// Next.js route, the ATS scripts, or a future report script alike, matching
// the convention in lib/ats/* and the rest of lib/sources/*.

import { detectApplyTarget } from '../ats-apply/detect'
import type { ApplyProviderId } from '../ats-apply/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which pipeline produced the row, at the coarsest useful grain. */
export type SourceKind = 'official_ats' | 'aggregator' | 'html_scrape' | 'unknown'

/**
 * The classification the vision doc asks for explicitly:
 *   - employer_official_board: a real, distinct employer, sourced straight off
 *     their own official ATS board (Greenhouse/Lever/Ashby public API).
 *   - employer_via_aggregator: a real, distinct employer identified through an
 *     aggregator/job board/HTML scrape — secondhand, not the employer's board.
 *   - aggregator_as_employer: the tracked "company" IS the aggregator (its
 *     domain resolves to arbeitnow.com/remoteok.com/etc, or the job's own URL
 *     never leaves the aggregator's site) — this is the failure mode the
 *     vision doc calls out: aggregator noise masquerading as an employer.
 *   - unverifiable: no source tag and no host signal strong enough to place
 *     the row in any of the above with confidence.
 */
export type EmployerClass =
  | 'employer_official_board'
  | 'employer_via_aggregator'
  | 'aggregator_as_employer'
  | 'unverifiable'

/** Coarse trust bucket for UI badges — collapses EmployerClass to 3 states. */
export type TrustTier = 'official' | 'secondhand' | 'unverified'

/** Why lastVerifiedAt/stillOpen have the value they do. */
export type VerificationBasis = 'reverified' | 'discovery-only' | 'unknown'

export interface ProvenanceVerification {
  /** ISO timestamp of the most recent reverification, or null if never. */
  lastVerifiedAt: string | null
  /** true = confirmed present in the source's most recent fetch; false =
   *  confirmed absent (closed); null = never explicitly checked either way. */
  stillOpen: boolean | null
  basis: VerificationBasis
}

/** The row shape computeJobProvenance() needs. All fields read-only inputs;
 *  nothing here is mutated. `lastVerifiedAt`/`stillOpen` are optional because
 *  the columns they'd read from don't exist in the live schema yet — see the
 *  migration note above. */
export interface JobProvenanceInput {
  jobId: string
  jobUrl: string | null
  /** Raw jobs.source value — adapter id (SourceId), AtsProviderId, 'scraper', or null. */
  jobSource: string | null
  description: string | null
  discoveredAt: string | null
  postedAt: string | null
  companyId: string
  companyName: string | null
  companyDomain: string | null
  /** companies.metadata.suggested === true (auto-created from an aggregator lead). */
  companySuggested: boolean
  /**
   * companies.metadata.ats.provider, when lib/ats/index.ts refreshCompany()
   * has independently confirmed a real official board for this company (see
   * AtsMetadata in lib/ats/types.ts). This is a STRONGER signal than
   * companyDomain: a company auto-created from an arbeitnow/remoteok lead
   * keeps that aggregator's host in its `domain` column forever (nothing
   * ever corrects it — see lib/sources/index.ts ingestLeads), but once the
   * ATS prober finds "Speechify" really does run a Greenhouse board (probing
   * off the company NAME, not the polluted domain), every job pulled through
   * that board is genuinely official even though companyDomain still reads
   * "arbeitnow.com". Verified against production data: of 18,520
   * greenhouse/lever/ashby-sourced jobs, 100% have a matching
   * companyAtsProvider — 2,906 of them on a company row whose domain is
   * still an aggregator host. Without this field those 2,906 real,
   * verified-official jobs would be misclassified as aggregator noise.
   */
  companyAtsProvider: ApplyProviderId | null
  /** jobs.last_verified_at once supabase/migrations/20260728000008_job_provenance.sql is applied. */
  lastVerifiedAt?: string | null
  /** jobs.still_open once that migration is applied. */
  stillOpen?: boolean | null
}

export interface JobProvenance {
  jobId: string
  source: {
    /** Raw jobs.source value, verbatim (may be null). */
    id: string | null
    /** Human label for the UI, e.g. "Greenhouse", "Arbeitnow", "Unknown". */
    label: string
    kind: SourceKind
  }
  employerClass: EmployerClass
  trustTier: TrustTier
  /** True when jobSource is one of the official-ATS adapters (greenhouse/lever/ashby). */
  isOfficialAts: boolean
  atsProvider: ApplyProviderId | null
  /**
   * True when companyDomain resolves to a known aggregator host — surfaced
   * for transparency even when employerClass is employer_official_board
   * (companyAtsProvider corroboration wins the classification; the stale
   * domain is still worth flagging as a company-record data-quality issue).
   */
  companyDomainLooksLikeAggregator: boolean
  descriptionComplete: boolean
  descriptionLength: number
  /** True when jobUrl matches a supported official-ATS apply URL shape
   *  (lib/ats-apply/detect.ts) — i.e. Cello's write path can attempt an
   *  automatic submit for this posting. Says nothing about whether the user
   *  has a credential configured; that's a Settings-level fact, not a
   *  per-job one. */
  autoApplySupported: boolean
  verification: ProvenanceVerification
  /** 0..1 composite confidence — how much this row's data should be trusted
   *  when ranking/matching. See computeConfidence() for the weights. */
  confidence: number
  /** Plain-language bullets a UI can render directly (vision: "Label
   *  provenance explicitly: AI proposed / user verified / externally confirmed"). */
  reasons: string[]
}

export interface ProvenanceBreakdown {
  total: number
  byEmployerClass: Record<EmployerClass, number>
  byTrustTier: Record<TrustTier, number>
  bySourceKind: Record<SourceKind, number>
  bySource: Record<string, number>
  descriptionComplete: number
  descriptionMissing: number
  autoApplySupported: number
  everVerified: number
}

// ---------------------------------------------------------------------------
// Host tables
// ---------------------------------------------------------------------------

/**
 * Hosts that serve OTHER people's job listings, not an employer's own site.
 * Deliberately scoped to the sources this app actually ingests from (see
 * lib/sources/*.ts) plus the third-party boards scripts/purge-garbage.ts
 * already treats as "auto-created, not user-tracked" — keep the two lists
 * loosely in sync if either grows.
 */
const AGGREGATOR_HOSTS = new Set([
  'themuse.com',
  'www.themuse.com',
  'echojobs.io',
  'www.echojobs.io',
  'remotive.com',
  'www.remotive.com',
  'weworkremotely.com',
  'www.weworkremotely.com',
  'himalayas.app',
  'www.himalayas.app',
  'workingnomads.com',
  'www.workingnomads.com',
  'jobicy.com',
  'www.jobicy.com',
  'arbeitnow.com',
  'www.arbeitnow.com',
  'remoteok.com',
  'www.remoteok.com',
  'remoteok.io',
  'ycombinator.com',
  'www.ycombinator.com',
  'news.ycombinator.com',
  'workatastartup.com',
  'www.workatastartup.com',
  'hn.algolia.com',
  'devitjobs.uk',
  'www.devitjobs.uk',
  'devitjobs.com',
  'join.com',
  'www.join.com',
  'linkedin.com',
  'www.linkedin.com',
  'indeed.com',
  'indeed.de',
  'glassdoor.com',
  'glassdoor.de',
  'ziprecruiter.com',
  'dice.com',
  'monster.com',
  'seek.com',
  'stepstone.de',
  'xing.com',
  'wellfound.com',
  'angel.co',
  'otta.com',
  'uctalent.io',
  'dover.com',
  'app.dover.com',
])

/** Official ATS vendor board hosts — a job whose URL lives here was posted on
 *  the vendor's board (job-boards.greenhouse.io/{token}, jobs.lever.co/{slug},
 *  jobs.ashbyhq.com/{org}), independent of what jobs.source says. Companies
 *  that embed the same ATS on their own domain (careers.airbnb.com) won't
 *  match this — jobs.source is the primary signal for those; this is a
 *  secondary corroboration used mainly for untagged legacy rows. */
const OFFICIAL_ATS_HOST_RE = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com)$/i

const ADAPTER_SOURCE_KIND: Record<string, SourceKind> = {
  greenhouse: 'official_ats',
  lever: 'official_ats',
  ashby: 'official_ats',
  arbeitnow: 'aggregator',
  remoteok: 'aggregator',
  hackernews: 'aggregator',
  ycombinator: 'aggregator',
  themuse: 'aggregator',
  echojobs: 'aggregator',
  remotive: 'aggregator',
  weworkremotely: 'aggregator',
  himalayas: 'aggregator',
  workingnomads: 'aggregator',
  jobicy: 'aggregator',
  scraper: 'html_scrape',
  // 'web_search' (lib/sources/types.ts SourceId) is DELIBERATELY absent here.
  // sourceKindOf() falls back to 'unknown' for it, which routes
  // classifyEmployer() into its unknown-source fallback below — that fallback
  // already checks companyAtsProvider, then the job URL's own host against a
  // real ATS vendor (atsProviderFromHost), before ever falling back to
  // 'unverifiable'. That is the CORRECT classification for a web-search hit:
  // when lib/search/job-discovery.ts resolved it through the real
  // greenhouse/lever/ashby API, the URL host proves it, so it should be
  // trusted exactly like any other official-board job — not laundered as a
  // generic aggregator, and not blindly trusted either. Mapping it to
  // 'aggregator' here instead would skip that host check and under-trust a
  // genuinely-verified official-board job.
}

const SOURCE_LABELS: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  arbeitnow: 'Arbeitnow',
  remoteok: 'RemoteOK',
  hackernews: 'Hacker News "Who is hiring"',
  ycombinator: 'Y Combinator / Work at a Startup',
  themuse: 'The Muse',
  echojobs: 'EchoJobs',
  remotive: 'Remotive',
  weworkremotely: 'We Work Remotely',
  himalayas: 'Himalayas',
  workingnomads: 'Working Nomads',
  jobicy: 'Jobicy',
  scraper: 'Careers-page scrape',
  web_search: 'Open-web search',
}

/** Exported so callers that need to ask "is this description complete?" without
 *  paying to transfer the description text itself (e.g. the /api/jobs/provenance
 *  ?summary=1 aggregate — see that route for the ILIKE-pattern trick this backs)
 *  can build the same threshold server-side instead of duplicating the number. */
export const MIN_DESCRIPTION_CHARS = 40

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  let host = domain.trim().toLowerCase()
  if (!host) return null
  try {
    if (host.includes('://')) host = new URL(host).hostname
  } catch {
    /* keep raw value */
  }
  return host.replace(/^www\./, '')
}

function isAggregatorHost(host: string | null): boolean {
  if (!host) return false
  return AGGREGATOR_HOSTS.has(host) || AGGREGATOR_HOSTS.has(`www.${host}`)
}

function atsProviderFromHost(host: string | null): ApplyProviderId | null {
  if (!host) return null
  if (/(?:^|\.)greenhouse\.io$/i.test(host)) return 'greenhouse'
  if (/(?:^|\.)lever\.co$/i.test(host)) return 'lever'
  if (/(?:^|\.)ashbyhq\.com$/i.test(host)) return 'ashby'
  return null
}

function sourceKindOf(source: string | null): SourceKind {
  if (!source) return 'unknown'
  return ADAPTER_SOURCE_KIND[source] ?? 'unknown'
}

function sourceLabelOf(source: string | null): string {
  if (!source) return 'Unknown / untagged'
  return SOURCE_LABELS[source] ?? source
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface EmployerClassification {
  employerClass: EmployerClass
  trustTier: TrustTier
  atsProvider: ApplyProviderId | null
}

function classifyEmployer(input: JobProvenanceInput, sourceKind: SourceKind): EmployerClassification {
  const jobHost = hostOf(input.jobUrl)
  const companyHost = normalizeDomain(input.companyDomain)
  const companyIsAggregator = isAggregatorHost(companyHost)
  const jobUrlIsAggregator = isAggregatorHost(jobHost)
  // Cello's own ATS prober confirmed a real board for this company (it
  // derives candidate tokens from the company NAME as well as its domain —
  // see lib/ats/detect.ts candidateTokens — so this can be true even when
  // companyDomain is polluted with an aggregator host). Strictly stronger
  // evidence than companyDomain; see the companyAtsProvider field doc.
  const atsMetadataConfirmsOfficial = input.companyAtsProvider !== null

  if (sourceKind === 'official_ats') {
    const atsProvider = (input.jobSource as ApplyProviderId | null) ?? atsProviderFromHost(jobHost)
    if (companyIsAggregator && !atsMetadataConfirmsOfficial) {
      return { employerClass: 'aggregator_as_employer', trustTier: 'secondhand', atsProvider }
    }
    // Our own read pipeline (lib/ats/*) only ever pulls a company's own
    // public board API — trustworthy by construction, and doubly so when the
    // cached ATS metadata corroborates it.
    return { employerClass: 'employer_official_board', trustTier: 'official', atsProvider }
  }

  if (sourceKind === 'aggregator' || sourceKind === 'html_scrape') {
    if (companyIsAggregator || jobUrlIsAggregator) {
      return { employerClass: 'aggregator_as_employer', trustTier: 'secondhand', atsProvider: null }
    }
    return { employerClass: 'employer_via_aggregator', trustTier: 'secondhand', atsProvider: null }
  }

  // sourceKind === 'unknown' — no adapter tag recorded on the job itself
  // (legacy/untagged rows). Fall back to the company's confirmed ATS, then
  // the URL host, in that order of trust.
  if (atsMetadataConfirmsOfficial) {
    return { employerClass: 'employer_official_board', trustTier: 'official', atsProvider: input.companyAtsProvider }
  }
  const hostAtsProvider = atsProviderFromHost(jobHost)
  if (hostAtsProvider) {
    return companyIsAggregator
      ? { employerClass: 'aggregator_as_employer', trustTier: 'secondhand', atsProvider: hostAtsProvider }
      : { employerClass: 'employer_official_board', trustTier: 'official', atsProvider: hostAtsProvider }
  }
  if (jobUrlIsAggregator || companyIsAggregator) {
    return { employerClass: 'aggregator_as_employer', trustTier: 'secondhand', atsProvider: null }
  }
  return { employerClass: 'unverifiable', trustTier: 'unverified', atsProvider: null }
}

function isDescriptionComplete(description: string | null): boolean {
  return !!description && description.trim().length >= MIN_DESCRIPTION_CHARS
}

function computeVerification(input: JobProvenanceInput): ProvenanceVerification {
  const lastVerifiedAt = input.lastVerifiedAt ?? null
  const stillOpen = input.stillOpen ?? null
  const basis: VerificationBasis = lastVerifiedAt
    ? 'reverified'
    : input.discoveredAt
      ? 'discovery-only'
      : 'unknown'
  return { lastVerifiedAt, stillOpen, basis }
}

/** 0..1 composite. Weighted mainly by employerClass (the dominant trust
 *  signal), then docked for a missing/short description. Not a match score —
 *  purely "how much should the rest of the product trust this row's data". */
function computeConfidence(
  employerClass: EmployerClass,
  descriptionComplete: boolean,
  verification: ProvenanceVerification
): number {
  const base: Record<EmployerClass, number> = {
    employer_official_board: 0.9,
    employer_via_aggregator: 0.55,
    aggregator_as_employer: 0.15,
    unverifiable: 0.3,
  }
  let score = base[employerClass]
  if (!descriptionComplete) score -= 0.15
  if (verification.stillOpen === false) score -= 0.4
  score = Math.max(0, Math.min(1, score))
  return Math.round(score * 100) / 100
}

/**
 * PROVENANCE VISIBILITY (round-2 fix): a web-search-discovered job must never
 * read identically to a job Cello's own board-watch pipeline pulled directly
 * — even when classifyEmployer()'s unknown-source fallback correctly grants
 * it employer_official_board/'official' trust because the URL was verified
 * against the real ATS API. That trust level is earned and should stay, but
 * the FIRST reason bullet must always say how this row was actually found.
 * Placed ahead of the class-specific bullet below (reasons[0]) precisely
 * because the earlier bug was a byte-identical reasons[0] between a
 * web_search-sourced job and a native jobs.source='greenhouse' job.
 */
function webSearchProvenanceReason(classification: EmployerClassification, company: string): string {
  // Key off atsProvider, not employerClass: a hit whose host matched a real
  // ATS vendor was genuinely re-verified against that board even when it
  // ends up classified aggregator_as_employer (e.g. the company's stored
  // domain is still a polluted aggregator host) — that job was still
  // ATS-verified, so it must not get the "could not be verified" wording.
  if (classification.atsProvider) {
    return (
      `Discovered via open-web search, then independently verified against ${company}'s real ` +
      `${classification.atsProvider} board before being tracked — not a job Cello's regular ` +
      `board-watch already knew about.`
    )
  }
  return (
    'Discovered via open-web search and could not be independently verified against a known ATS board ' +
    '— treat this listing with extra caution until confirmed.'
  )
}

function buildReasons(
  input: JobProvenanceInput,
  sourceKind: SourceKind,
  classification: EmployerClassification,
  descriptionComplete: boolean,
  descriptionLength: number,
  autoApplySupported: boolean,
  verification: ProvenanceVerification
): string[] {
  const reasons: string[] = []
  const sourceLabel = sourceLabelOf(input.jobSource)
  const company = input.companyName?.trim() || 'the employer'

  if (input.jobSource === 'web_search') {
    reasons.push(webSearchProvenanceReason(classification, company))
  }

  switch (classification.employerClass) {
    case 'employer_official_board':
      reasons.push(
        `Pulled directly from ${company}'s own ${classification.atsProvider ?? sourceLabel} board — the most trustworthy source available.`
      )
      break
    case 'employer_via_aggregator':
      reasons.push(
        `Discovered through ${sourceLabel}, an aggregator — not ${company}'s own board, so treat details as secondhand.`
      )
      break
    case 'aggregator_as_employer':
      reasons.push(
        `The tracked "company" here (${company}) resolves to ${sourceLabel} itself, not a distinct employer — this looks like aggregator noise, not a genuine opportunity.`
      )
      break
    case 'unverifiable':
      reasons.push('No reliable source signal was recorded for this job — provenance is unknown.')
      break
  }

  if (!descriptionComplete) {
    reasons.push(
      descriptionLength === 0
        ? 'No job description was captured — any score is based on the title alone.'
        : `Description is only ${descriptionLength} characters — likely incomplete.`
    )
  }

  reasons.push(
    autoApplySupported
      ? 'Posting URL matches a supported official-ATS apply flow — automatic submission is possible.'
      : 'Automatic application is not available for this posting — it must be finished on the employer site.'
  )

  if (verification.basis === 'unknown') {
    reasons.push('No discovery date on record — cannot say when this was last confirmed open.')
  } else if (verification.basis === 'discovery-only') {
    reasons.push(`Seen once on ${input.discoveredAt} and never re-checked since.`)
  }
  if (verification.stillOpen === false) {
    reasons.push('Last check found this posting closed.')
  }

  const companyHost = normalizeDomain(input.companyDomain)
  if (isAggregatorHost(companyHost) && classification.employerClass === 'employer_official_board') {
    reasons.push(
      `Note: this company's stored domain (${companyHost}) is still the aggregator it was first discovered through — Cello has since found and verified its real ${classification.atsProvider ?? ''} board independently.`
    )
  }

  return reasons
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute the full provenance record for one job. Pure, never throws. */
export function computeJobProvenance(input: JobProvenanceInput): JobProvenance {
  const sourceKind = sourceKindOf(input.jobSource)
  const classification = classifyEmployer(input, sourceKind)
  const descriptionLength = input.description?.trim().length ?? 0
  const descriptionComplete = isDescriptionComplete(input.description)
  const autoApplySupported = detectApplyTarget(input.jobUrl) !== null
  const verification = computeVerification(input)
  const confidence = computeConfidence(classification.employerClass, descriptionComplete, verification)

  return {
    jobId: input.jobId,
    source: {
      id: input.jobSource,
      label: sourceLabelOf(input.jobSource),
      kind: sourceKind,
    },
    employerClass: classification.employerClass,
    trustTier: classification.trustTier,
    isOfficialAts: sourceKind === 'official_ats',
    atsProvider: classification.atsProvider,
    companyDomainLooksLikeAggregator: isAggregatorHost(normalizeDomain(input.companyDomain)),
    descriptionComplete,
    descriptionLength,
    autoApplySupported,
    verification,
    confidence,
    reasons: buildReasons(
      input,
      sourceKind,
      classification,
      descriptionComplete,
      descriptionLength,
      autoApplySupported,
      verification
    ),
  }
}

/** Batch form — same computation, no I/O, safe to map over any page of rows. */
export function computeJobProvenanceBatch(inputs: JobProvenanceInput[]): JobProvenance[] {
  return inputs.map(computeJobProvenance)
}

const EMPLOYER_CLASSES: EmployerClass[] = [
  'employer_official_board',
  'employer_via_aggregator',
  'aggregator_as_employer',
  'unverifiable',
]
const TRUST_TIERS: TrustTier[] = ['official', 'secondhand', 'unverified']
const SOURCE_KINDS: SourceKind[] = ['official_ats', 'aggregator', 'html_scrape', 'unknown']

/** Aggregate a set of provenance records into corpus-wide counts — what the
 *  bulk report route returns and what the acceptance breakdown is built from. */
export function summarizeProvenance(records: JobProvenance[]): ProvenanceBreakdown {
  const byEmployerClass = Object.fromEntries(EMPLOYER_CLASSES.map((k) => [k, 0])) as Record<EmployerClass, number>
  const byTrustTier = Object.fromEntries(TRUST_TIERS.map((k) => [k, 0])) as Record<TrustTier, number>
  const bySourceKind = Object.fromEntries(SOURCE_KINDS.map((k) => [k, 0])) as Record<SourceKind, number>
  const bySource: Record<string, number> = {}

  let descriptionComplete = 0
  let autoApplySupported = 0
  let everVerified = 0

  for (const r of records) {
    byEmployerClass[r.employerClass]++
    byTrustTier[r.trustTier]++
    bySourceKind[r.source.kind]++
    const key = r.source.id ?? '(untagged)'
    bySource[key] = (bySource[key] ?? 0) + 1
    if (r.descriptionComplete) descriptionComplete++
    if (r.autoApplySupported) autoApplySupported++
    if (r.verification.lastVerifiedAt) everVerified++
  }

  return {
    total: records.length,
    byEmployerClass,
    byTrustTier,
    bySourceKind,
    bySource,
    descriptionComplete,
    descriptionMissing: records.length - descriptionComplete,
    autoApplySupported,
    everVerified,
  }
}
