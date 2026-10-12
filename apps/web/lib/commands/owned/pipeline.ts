// Tables a person owns by user_id, for demo wipe and account deletion.
// This lane adds a table here in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

export const owned: OwnedTable[] = [
  // Brought here until K13 renames it in the migration that extends it.
  { table: 'application_receipts', demoWipe: false },
]
