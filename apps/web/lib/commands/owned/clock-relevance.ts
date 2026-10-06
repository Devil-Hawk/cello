// Tables a person owns by user_id, for demo wipe and account deletion.
// This lane adds a table here in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

export const owned: OwnedTable[] = [
  { table: 'company_suggestion_state', demoWipe: false },
  { table: 'company_suggestions', demoWipe: false },
  { table: 'job_heartbeats', demoWipe: false },
  { table: 'person_counts', demoWipe: false },
  { table: 'person_roles', demoWipe: false },
  { table: 'role_type_synonyms', demoWipe: false },
  { table: 'routines', demoWipe: false },
]
