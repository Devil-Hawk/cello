// Tables this lane owns, and how each says where its values come from.
// Add a table here in the same commit as the migration that creates it.

import type { ProvenanceTable } from './types'

export const tables: ProvenanceTable[] = [
  { table: 'chats', provenance: 'code' },
  { table: 'chat_turns', provenance: 'origin' },
  { table: 'chat_attachments', provenance: 'origin' },
  { table: 'projects', provenance: 'person' },
  { table: 'proposals', provenance: 'origin' },
]
