// Types for who may see a role and why a role was not kept. Types only: nothing here runs.
//
// Pushed first (v4/clock-relevance-k5a-types) so the lanes that render or read these rows can import
// them before the code that fills them exists. This file grows with K5c (role types and `type_prov`)
// and K5d (the posting's Markdown and requirement items).
//
// The tables are in migration 20261008050000: person_roles, person_counts, seen_postings,
// company_directory. A stored role is one `jobs` row per posting; `person_roles` says who may see it.

/** Why a person's stored role is hidden from their lists. A role that is not hidden has no reason. */
export type HiddenReason = 'not_for_me' | 'unclassified'

/** The tier of the reader that produced a role (jobs.source_tier). */
export type SourceTier = 'board' | 'site_search' | 'sitemap' | 'listing' | 'rendered' | 'model'

/** An agency or a repost is stored but never shown as the employer's own (jobs.legit_label). */
export type LegitLabel = 'agency' | 'repost'

/** One row of person_roles: the person's relation to one stored role. Everything per person lives here, never on `jobs`. */
export interface PersonRole {
  user_id: string
  job_id: string
  /** When the role became visible to this person (ISO). */
  visible_since: string
  /** The version of the person's targets the role was kept under; 0 when they had set none. */
  targets_version: number
  /** Set when the person saved the role. A saved role is never pruned. */
  saved_at: string | null
  hidden_reason: HiddenReason | null
  /** The last time a check confirmed the role against the employer's listing (ISO). */
  checked_at: string | null
}

/** The stage of the targets code that decided a role is not for a person (lib/jobs/target-relevance.ts). */
export type OutsideReason = 'place' | 'age' | 'excluded' | 'level' | 'title'

/** What a person_counts row counts. Counts are numbers, never rows of roles (directive 26). */
export type CountKind = 'outside_targets' | 'untraced' | 'cannot_read' | 'untyped' | 'shadow_keep' | 'shadow_drop'

/** One row of person_counts: "120 outside your search because of place" at one employer on one day. */
export interface PersonCount {
  user_id: string
  /** The day (UTC) the read happened, as YYYY-MM-DD. */
  day: string
  employer_id: string | null
  /** The person's own company row, when the employer is not in the directory yet. */
  company_id: string | null
  kind: CountKind
  /** An OutsideReason for kind outside_targets; free for the other kinds. */
  reason: string
  /** How many roles of that kind the read of that day found. A day's read replaces the day's number. */
  n: number
}

/** The shared employer: one row per verified employer, written only by `companies.verify`. */
export interface EmployerRef {
  id: string
  name: string
  domain: string | null
  logo_url: string | null
  /** The last read's total of open roles ("of 636 open"). */
  open_count: number | null
  open_count_at: string | null
}
