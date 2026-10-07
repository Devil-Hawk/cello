// Types for who may see a role and why a role was not kept. Types only: nothing here runs.
//
// Pushed first (v4/clock-relevance-k5a-types) so the lanes that render or read these rows can import
// them before the code that fills them exists. This file grows with K5c (role types and `type_prov`, below)
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

/** How a role came to be the person's: a check read it (check), they pasted a link (link), or they hold it as a followed employer's role (company; K5d). */
export type RoleVia = 'check' | 'link' | 'company'

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
  /** K5c. How the role became the person's. */
  via: RoleVia | null
  /** K5c. The person's own correction of the role's type: null when they made none. By definition the person's, so it carries no origin. */
  role_type: string | null
}

/** The stage of the targets code that decided a role is not for a person (lib/jobs/target-relevance.ts). */
/** `type` and `untyped` replace `title` while role_types_live is on (K5c): another role type, and a type no tier could tell. */
export type OutsideReason = 'place' | 'age' | 'excluded' | 'level' | 'title' | 'type' | 'untyped'

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

// --- Role types (K5c; taxonomy in lib/jobs/role-types, section 6.1) ------------------------------------

/** The kind of job a posting is, apart from its level. */
export interface RoleType {
  id: string
  label: string
  /** A `job_function` value. */
  family: string
  related: string[]
  taxonomy_version: number
  retired_at: string | null
}

/** Who typed a title or role. Never 'person' on a posting: a person's correction lives on person_roles. */
export type TypeOrigin = 'code' | 'model'

/** Why a role has its type (3.2). `rule` for code; the embedder and the model step add their own fields in K15b. */
export interface TypeProv {
  rule?: 'synonym' | 'pattern' | 'department'
  pattern?: string
  taxonomy_version?: number
  step?: string
  model?: string
  rung?: string
  evidence?: { quote: string }[]
  similarity?: number
  margin?: number
  runner_up?: string
  at?: string
  /** 'posting': the answer leaned on one posting's text, so it is kept on that role only, never on title_types. */
  scope?: 'posting'
}

/** One judgement per (normalised title, department): shared by every employer and person. */
export interface TitleType {
  title_norm: string
  /** The normalised department or team for a title on the ambiguous list, else the empty string. */
  dept_norm: string
  role_type: string | null
  origin: TypeOrigin
  prov: TypeProv | null
  taxonomy_version: number
  status: 'typed' | 'pending' | 'none'
  n_seen: number
  typed_at: string | null
}

/** The person's own word for a title: a correction, or a title they typed and accepted the type Cello named. */
export interface RoleTypeSynonym {
  user_id: string
  title_norm: string
  role_type: string
  source: 'correction' | 'typed'
}

// --- The posting, whole (K5d; blueprint 6 "What the reader keeps") --------------------------------------

/** full: the employer's whole text. partial: only a listing's snippet could be read, or the body passed the guard. none: no body yet. cleared: the body was cleared at the storage alert and is read again on open. */
export type DescriptionState = 'full' | 'partial' | 'none' | 'cleared'

/** Where the body came from: the applicant system's API, the posting page's JSON-LD, its detail page, the rendered page, or a listing. */
export type DescriptionSource = 'api' | 'jsonld' | 'detail' | 'rendered' | 'listing'

/** What the reader stores of one posting's body. `description_md5` is the md5 of `description_md`: null with no body, and kept when the body is cleared. */
export interface PostingCapture {
  description_md: string | null
  description_state: DescriptionState
  description_source: DescriptionSource | null
  apply_url: string | null
  description_md5: string | null
}

/** One requirement of a posting (requirements version 2): a bullet or sentence under a requirements heading. */
export interface RequirementItem {
  /** A hash of the normalised text: the same requirement keeps its id when the posting is edited elsewhere. */
  id: string
  text: string
  kind: 'must' | 'nice' | 'other'
  /** The heading it sat under, as the posting wrote it. */
  heading: string
  /** The posting's own words for it: always a substring of `description_md`. */
  quote: string
  skills: string[]
  years: { min: number | null; max: number | null } | null
  degree: string | null
  visa: 'offered' | 'not_offered' | null
  clearance: string | null
  origin: 'code' | 'model'
  prov: { rule?: string; step?: string; model?: string; at?: string }
}
