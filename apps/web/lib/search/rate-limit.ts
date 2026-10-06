// The per-person limit on /api/search: 12 a minute, counted by take_command_slot
// so it holds across every function instance (the in-memory window it replaces
// gave each instance its own count). The number lives in lib/commands/limits.ts
// next to every other limit. DuckDuckGo is free but shared and the other
// backends are metered, so this must not be callable in an unbounded loop.

import { createAdminClient } from '@/lib/harness/supabase-admin'
import { limitFor } from '@/lib/commands/limits'
import { rpcSlotStore, type SlotStore } from '@/lib/commands/slots'

/** True if this request should be allowed. The attempt is counted either way, so
 *  a person over the limit stays over it for the rest of the window. A failure
 *  to count throws: a limit that cannot be checked is not a limit. */
export async function allowSearchRequest(userId: string, store?: SlotStore): Promise<boolean> {
  const limit = limitFor('search', 'session')
  if (!limit) return true
  return (store ?? rpcSlotStore(createAdminClient())).take({
    userId,
    channel: 'session',
    bucket: 'search',
    limit: limit.limit,
    windowSeconds: limit.windowSeconds,
  })
}
