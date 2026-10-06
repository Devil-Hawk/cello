// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'application_receipts', provenance: 'code' },
]
