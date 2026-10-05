// Shared shapes for the personal shortlist. Pure types: nothing here imports a
// framework, so the eval script, the API routes and the tests all use them.

export type Reaction = 'interested' | 'not_for_me' | 'applied'

export const PASS_REASONS = ['too_junior', 'too_senior', 'company', 'domain', 'location', 'pay', 'other'] as const
export type PassReason = (typeof PASS_REASONS)[number]

/** Where a role was shown when the person reacted to it. */
export type Surface = 'today' | 'opportunities' | 'chat' | 'pipeline'

export type PickKind = 'top' | 'explore'

export type Chance = 'strong' | 'possible' | 'stretch' | 'cannot_assess'

/** What Cello knows about a posting. Built from the jobs row plus its company. */
export interface RoleFacts {
  id: string
  title: string
  company: string
  location: string | null
  description: string | null
  salaryRange?: string | null
  /** Classifier output (lib/jobs/classify.ts), when known. */
  seniority?: string | null
  country?: string | null
  isRemote?: boolean | null
  jobFunction?: string | null
}

/** The want signals Cello had for a role before the person reacted to it. */
export interface Predicted {
  /** Holistic judge, given the person's own decisions. */
  judge: number | null
  /** Taste similarity to the roles they liked versus passed on. */
  embedding: number | null
  /** The judge's read of the stated preferences alone. */
  stated: number | null
  blended: number
}

/** One reaction, with the snapshot of the role it was about. */
export interface ReactionRecord {
  /** Row id, so an embedding computed later can be written back to it. */
  id: string
  jobId: string | null
  reaction: Reaction
  reason: PassReason | null
  title: string
  company: string
  location: string | null
  /** Compact text of the role at the time (title, company, location, description excerpt). */
  text: string
  embedding: number[] | null
  embeddingModel: string | null
  predicted: Predicted | null
  at: string
}

export interface BlockReason {
  kind: 'location' | 'sponsorship' | 'salary' | 'company' | 'seniority' | 'remote' | 'keyword'
  /** A sentence in the person's terms, stating the fact they gave. */
  text: string
}

export interface RequirementCheck {
  requirement: string
  mustHave: boolean
  status: 'met' | 'partial' | 'not_met' | 'unclear'
  /** The line of the resume that supports it. Null when nothing does. */
  evidence: { line: number; quote: string } | null
}

export interface ChanceResult {
  chance: Chance
  checks: RequirementCheck[]
  gaps: string[]
  note: string | null
}

export interface WantResult {
  p: number
  reason: string
  calibrated: boolean
  components: { judge: number | null; embedding: number | null; stated: number | null }
  nReactions: number
}

export interface Assessment {
  jobId: string
  blocked: boolean
  blockedReasons: BlockReason[]
  want: WantResult | null
  chance: ChanceResult | null
}

export interface ShortlistPick {
  jobId: string
  position: number
  kind: PickKind
  explanation: string
}
