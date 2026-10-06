// The made-thing type set (blueprint 3.3, K17). One store, `artifacts`, holds everything Cello
// makes for a person: resumes (base and tailored), cover letters, answers drafted for a form,
// messages, research, comparisons, kept answers and shortlists.
//
// Two names changed: `outreach_email` is now `message` and `dossier` is now `research`. The change
// is expand then contract. While both names may be stored, code writes the new name and reads
// both through readType(). After the contract migration no row holds an old name, and a source
// test fails on the old names anywhere but here and in the migrations.

export const ARTIFACT_TYPES = ['resume', 'cover_letter', 'answers', 'message', 'research', 'comparison', 'answer', 'shortlist'] as const
export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

/** Old name to new name. The one place the old names live in code. */
export const OLD_NAMES = { outreach_email: 'message', dossier: 'research' } as const

/** Every name a stored row may carry between the expand and the contract. */
export type StoredArtifactType = ArtifactType | keyof typeof OLD_NAMES

/** The type a stored name stands for, or null when it is not a made-thing type. */
export function readType(stored: string): ArtifactType | null {
  const name = (OLD_NAMES as Record<string, ArtifactType>)[stored] ?? stored
  return (ARTIFACT_TYPES as readonly string[]).includes(name) ? (name as ArtifactType) : null
}

/** The stored names that mean `type`, for a query that must find rows of either name. */
export function storedNames(type: ArtifactType): string[] {
  return [type, ...Object.entries(OLD_NAMES).filter(([, v]) => v === type).map(([k]) => k)]
}

/** What a made thing is about: every object it concerns, with `job_id`, `company_id` and `contact_id` kept as indexed copies of the first of each. */
export interface ArtifactAbout {
  kind: 'job' | 'company' | 'contact' | 'application' | 'person' | 'chat'
  ref: string
}
