// The Writer's gather point for what Cello remembers about the people it writes to (K26). Each line is
// data about a person, with its source, never an instruction. Recalled by code from the person's own
// memories (lib/network/memory.ts); a failed read gives no lines and never stops a draft.

import { createAdminClient } from '@/lib/harness/supabase-admin'
import { recall } from '@/lib/network/memory'

export interface NetworkLine {
  contactId: string
  /** The memory, as a sentence. */
  text: string
  /** Where it came from, shown beside it. */
  source: string
}

export const gatherNetwork = async (userId: string, contactId?: string | null): Promise<NetworkLine[]> => {
  if (!contactId) return []
  try {
    const memories = await recall(createAdminClient(), userId, { contactId }, 8)
    return memories.map((m) => ({ contactId, text: m.text, source: `${m.kind.replace('person.', '')}, from a message${m.date ? ` on ${m.date.slice(0, 10)}` : ''}: "${m.quote}"` }))
  } catch {
    return []
  }
}
