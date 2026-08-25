// Job-aggregator source adapters — shared types.
//
// These adapters read PUBLIC JSON APIs only (no HTML scraping, no auth) and
// return a normalized `JobLead`. The sourcer agent (lib/harness/agents/sourcer.ts)
// queries every adapter, dedupes against existing jobs, auto-creates the missing
// companies, and inserts the jobs via the service-role Supabase client.
//
// Framework-free by design (global fetch/URL only) so the same code can run in a
// Next.js route or a plain tsx script, exactly like lib/ats/*. Relative imports
// only (no `@/` path aliases) — `../targeting` and `../jobs/classify` are both
// zero-dependency pure modules so importing them here does not violate that.

import type { Targeting } from '../targeting'

export type SourceId =
  | 'themuse'
  | 'arbeitnow'
  | 'remoteok'
  | 'hackernews'
  | 'ycombinator'
  | 'echojobs'
  | 'remotive'
  | 'weworkremotely'
  | 'himalayas'
  | 'workingnomads'
  | 'jobicy'
  /**
   * The harness's own open-web search tool (lib/search/job-discovery.ts) —
   * the LAST rung of sourcer.ts's broaden-on-empty ladder, used only when
   * every keyless aggregator above still comes up short. NOT registered in
   * `sourceAdapters` below: unlike the adapters, it doesn't return raw leads
   * from one fixed API — every hit is independently verified (resolved
   * through the real ATS adapters, or liveness-checked) before it becomes a
   * JobLead, so it needs its own orchestration rather than the SourceAdapter
   * fan-out contract. Kept as a real SourceId anyway so a search-discovered
   * job is honestly tagged in jobs.source and lib/sources/provenance.ts can
   * tell it apart from a job Cello already tracks via a company's own board.
   */
  | 'web_search'

/** A single normalized job posting from an aggregator source. */
export interface JobLead {
  /** Employer name (best-effort; freeform sources may be noisy). */
  company: string
  /** Role title. */
  title: string
  /** Canonical apply/landing URL. Also used as the dedup key + external_id. */
  url: string
  /** Human location string, or null when unknown / remote-only. */
  location: string | null
  /** Salary range string when the source provides one. */
  salary: string | null
  /** Plain-text description (HTML already stripped). May be empty. */
  description: string
  /** Which adapter produced this lead. */
  source: SourceId
  /** Stable identifier for dedup — defaults to the canonical URL. */
  externalId: string
  /** Best-effort employer web domain, used to build a favicon logo. */
  companyDomain?: string | null
  /** ISO timestamp the role was posted, when known. */
  postedAt?: string | null
  /** Free-form tags/skills the source attached (used for keyword relevance). */
  tags?: string[]
}

/** Query parameters derived from the user's preferences + resume. */
export interface SourceQuery {
  /** Resume skills + query terms, lower-cased, deduped. Empty = "anything". */
  keywords: string[]
  /** Preferred location strings (lower-cased). */
  locations: string[]
  /** True when the user prefers remote work. */
  remote: boolean
  /** Max leads to return from THIS source (post-filter). */
  limit: number
  /** Abort signal (budget/cancel) forwarded from the harness step. */
  signal?: AbortSignal
  /**
   * The user's full targeting preferences (lib/targeting.ts), when the caller
   * has them available. Optional + additive: existing callers that only set
   * keywords/locations/remote/limit keep compiling and keep their previous
   * keyword-only behavior. When present, adapters use it for server-side
   * filtering (themuse category/location params, arbeitnow's DE/EU gate)
   * instead of guessing from freeform keywords alone. Absent/EMPTY_TARGETING
   * means "unconfigured" — adapters should stay conservative rather than
   * treat that as "no constraints, fetch everything."
   */
  targeting?: Targeting
}

/** An adapter over one public job source. */
export interface SourceAdapter {
  id: SourceId
  label: string
  /** Fetch + normalize + relevance-filter leads. Never throws on empty. */
  fetchLeads(q: SourceQuery): Promise<JobLead[]>
}
