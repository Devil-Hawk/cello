// A role's strengths and gaps for one person, with the evidence (blueprint 4.6, K17b). Types only:
// nothing here runs. Pushed first (v4/learning-writer-k17b-types) so the record page can import its
// shape before the code that fills it exists.
//
// A requirement of a posting is read against what the person has: their base resume, their saved answers,
// the facts on their profile, and the material they allow. Each requirement ends as one of three:
//   strength  the person's own words show it, with the quote
//   gap       a model or the person says it is missing
//   unknown   nothing found, or not read yet
// Code decides the first pass. A model's verdict and a person's correction are stored (role_evidence);
// code verdicts are computed on read and never stored.

import type { Origin, Prov } from '../provenance/types'

/** What a requirement is read from. `ref` names the stored record the quote was found in. */
export type EvidenceSource = 'resume' | 'answer' | 'profile' | 'material'

export interface FitEvidence {
  source: EvidenceSource
  /** The id of the record: a resume version, a saved answer, a profile fact or a material chunk. */
  ref: string
  /** Words copied from that record. A quote that is not in its record is never kept. */
  quote: string
}

export type FitVerdict = 'strength' | 'gap' | 'unknown'

/** The posting's requirement as the fit reads it. A RequirementItem (K5d) is one of these. */
export interface FitRequirement {
  id: string
  text: string
  /** Skills the posting names in it, already normalised. */
  skills: string[]
  kind: 'must' | 'nice' | 'other'
}

export interface FitItem {
  requirementId: string
  requirement: string
  verdict: FitVerdict
  /** The words that show a strength. Empty for a gap or an unknown. */
  evidence: FitEvidence[]
  /** Who decided: code (the first pass), a model step, or the person (a correction). */
  origin: Origin
  /** True when code looked in every place it may and found no term: a fact about where it looked, not a verdict. */
  notFound?: boolean
  /** The person's own note on a correction. */
  note?: string
}

/** What the page shows when nothing was found anywhere. */
export const NOT_FOUND = 'Not found in your resume, answers or material'

/** What the page shows for items only a model could read, when none can run. */
export const NEEDS_MODEL = 'Cello needs a model to read this one'

export interface FitStrip {
  strengths: number
  /** Gaps a model or the person named. A Not found item is counted under `unknown`. */
  gaps: number
  unknown: number
}

/** One role's fit as the record shows it. */
export interface RoleFitView {
  items: FitItem[]
  strip: FitStrip
  /** True when some items could only be read by a model that is not available to this person right now. */
  needsModel: boolean
  /** When a model last read this role, null when only code has. */
  readAt: string | null
}

/** One row of `role_evidence`: only what a model judged or the person corrected. */
export interface RoleEvidenceRow {
  user_id: string
  job_id: string
  items: FitItem[]
  origin: Origin
  prov: Prov | { rule: string } | { door: string } | null
  confirmed_at: string | null
  /** md5 of the posting's text when the verdicts were made. */
  desc_md5: string | null
  /** A hash of what the person's material was when the verdicts were made. */
  material_key: string
  computed_at: string
}
