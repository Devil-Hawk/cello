// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'application_attempts', provenance: 'code' },
  { table: 'pipeline_events', provenance: 'code' },
  { table: 'answer_bank', provenance: 'origin' },
  { table: 'messages', provenance: 'origin' },
  { table: 'notification_log', provenance: 'code' },
  { table: 'push_subscriptions', provenance: 'person' },
]
