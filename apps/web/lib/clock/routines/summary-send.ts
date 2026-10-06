// summary.send: the daily summary, to the person's own inbox, from their own routine row. Everything
// that decides whether it goes (switch, demo, quiet hours, send grant, once a day, once an hour) is in
// lib/notifications/deliver.ts; this only carries the answer back to the clock.

import { sendSummary, type SummaryOutcome } from '@/lib/notifications/deliver'
import { selfMailer } from '@/lib/notifications/mail'
import type { RoutineContext, RoutineOutcome } from '../routines'

const FAILED: SummaryOutcome[] = ['failed']

export async function summarySend(ctx: RoutineContext): Promise<RoutineOutcome> {
  if (!ctx.userId) return { ok: false, failure: 'no_person' }
  const outcome = await sendSummary({ admin: ctx.admin as never, sendToSelf: selfMailer(ctx.admin as never), now: new Date(ctx.now()) }, ctx.userId)
  return { ok: !FAILED.includes(outcome), found: { outcome }, ...(FAILED.includes(outcome) ? { failure: 'mail_failed' } : {}) }
}
