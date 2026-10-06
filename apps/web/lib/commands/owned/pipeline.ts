// Tables a person owns by user_id, for demo wipe and account deletion.
// This lane adds a table here in the same commit as the migration that creates it.

import type { OwnedTable } from './types'

export const owned: OwnedTable[] = [
  { table: 'application_attempts', demoWipe: false },
  { table: 'pipeline_events', demoWipe: false },
  { table: 'answer_bank', demoWipe: false },
  { table: 'messages', demoWipe: false },
  { table: 'notification_log', demoWipe: false },
  { table: 'push_subscriptions', demoWipe: false },
]
