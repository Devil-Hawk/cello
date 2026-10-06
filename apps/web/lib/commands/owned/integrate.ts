// Tables a person owns by user_id, for demo wipe and account deletion.
// This lane adds a table here in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

export const owned: OwnedTable[] = [
  { table: 'agent_tasks', demoWipe: false },
  { table: 'approvals', demoWipe: false },
  { table: 'artifacts', demoWipe: false },
  { table: 'feedback_events', demoWipe: false },
  { table: 'scheduled_tasks', demoWipe: false },
  { table: 'shortlist_items', demoWipe: false },
  { table: 'taste_models', demoWipe: false },
]
