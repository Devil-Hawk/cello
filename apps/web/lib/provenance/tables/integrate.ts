// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'agent_tasks', provenance: 'code' },
  { table: 'approvals', provenance: 'code' },
  { table: 'artifacts', provenance: 'origin' },
  { table: 'feedback_events', provenance: 'person' },
  { table: 'scheduled_tasks', provenance: 'person' },
  { table: 'shortlist_items', provenance: 'code' },
  { table: 'taste_models', provenance: 'code' },
]
