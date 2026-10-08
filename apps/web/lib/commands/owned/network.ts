// Tables a person owns by user_id, for demo wipe and account deletion.
// This lane adds a table here in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

export const owned: OwnedTable[] = [
  // both go with their contact, which the demo sweep deletes (on delete cascade)
  { table: 'contact_applications', demoWipe: false },
  { table: 'contact_profiles', demoWipe: false },
]
