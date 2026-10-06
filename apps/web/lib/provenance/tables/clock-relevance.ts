// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'company_suggestion_state', provenance: 'code' },
  { table: 'company_suggestions', provenance: 'code' },
  { table: 'job_heartbeats', provenance: 'code' },
  { table: 'person_counts', provenance: 'code' },
  { table: 'person_roles', provenance: 'origin' },
  { table: 'role_type_synonyms', provenance: 'code' },
  { table: 'routines', provenance: 'origin' },
]
