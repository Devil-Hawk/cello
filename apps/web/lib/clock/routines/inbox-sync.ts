// inbox.sync: the hourly mail read. It reads each connected person in turn through lib/gmail/inbox.ts,
// which keeps a heartbeat per person (so a failing mailbox shows as that person's, not as the routine's).

import { syncAllInboxes } from '@/lib/gmail/inbox'
import type { RoutineContext, RoutineOutcome } from '../routines'

export async function inboxSync(ctx: RoutineContext): Promise<RoutineOutcome> {
  const r = await syncAllInboxes(ctx.admin as never)
  if (!r.ok) return { ok: false, failure: 'profiles_unreadable' }
  const failed = r.results.filter((x) => x.error).length
  return { ok: true, found: { connected: r.eligibleUsers, read: r.processed - failed, failed } }
}
