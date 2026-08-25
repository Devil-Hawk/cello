export interface ContactCompany {
  id: string
  name: string
  logo_url: string | null
}

export interface Contact {
  id: string
  user_id: string
  company_id: string | null
  name: string
  email: string | null
  linkedin_url: string | null
  title: string | null
  relationship: string | null
  last_contact_at: string | null
  notes: string | null
  created_at: string
  companies: ContactCompany | null
  /**
   * Provenance for contacts Cello sourced automatically (see POST
   * /api/contacts/source) — absent/null on a manually-entered contact, and
   * absent entirely if supabase/migrations/20260728000007_contact_provenance.sql
   * hasn't been applied yet. `verified` is only ever true when a provider
   * (Hunter) ran a real deliverability check — see ContactProvenanceBadge.
   */
  source?: string | null
  confidence?: number | null
  verified?: boolean | null
  basis?: string | null
}

export type Relationship =
  | 'colleague'
  | 'friend'
  | 'recruiter'
  | 'alumni'
  | 'linkedin_connection'
  | 'other'

export interface ContactFormValues {
  name: string
  email: string
  companyId: string | null
  linkedinUrl: string
  title: string
  relationship: Relationship | ''
  notes: string
}

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: '',
  email: '',
  companyId: null,
  linkedinUrl: '',
  title: '',
  relationship: '',
  notes: '',
}

export const RELATIONSHIP_LABELS: Record<string, string> = {
  colleague: 'Colleague',
  friend: 'Friend',
  recruiter: 'Recruiter',
  alumni: 'Alumni',
  linkedin_connection: 'LinkedIn Connection',
  other: 'Other',
}

/**
 * lib/contacts/sources.ts (POST /api/contacts/source) hard-codes
 * `relationship: 'sourced'` on every automatically-sourced contact — it isn't
 * a real value from the Relationship union above, and is NOT a personal
 * connection the candidate actually has. Anything comparing `relationship` to
 * decide "does the user already know this person" (warm-path surfaces) must
 * exclude this sentinel, or every auto-sourced contact would misleadingly
 * read as an existing personal relationship.
 */
export const AUTO_SOURCED_RELATIONSHIP = 'sourced'

export function isPersonalRelationship(value: string | null | undefined): boolean {
  return !!value && value !== AUTO_SOURCED_RELATIONSHIP
}

export const RELATIONSHIP_OPTIONS: Array<{ value: Relationship; label: string }> = [
  { value: 'colleague', label: 'Colleague' },
  { value: 'friend', label: 'Friend' },
  { value: 'recruiter', label: 'Recruiter' },
  { value: 'alumni', label: 'Alumni' },
  { value: 'linkedin_connection', label: 'LinkedIn Connection' },
  { value: 'other', label: 'Other' },
]

/** Row shape produced by the CSV importer — page adds user_id before insert. */
export interface CsvContactRow {
  name: string
  email: string | null
  title: string | null
  linkedin_url: string | null
}
