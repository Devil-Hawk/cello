// postings.backfill: bodies for roles stored before posting capture (K5d), on the clock.
//
// In SQL (backfill_posting_bodies): a role no reader will see soon takes the plain copy it already has, marked
// partial when that copy sits at the 20,000-character cap; a followed employer whose roles still have no body is made
// due at once, applied-to employers first, and its person's check is brought forward. The reader's next read of the
// employer stores the whole body, the Markdown and the requirement items.
//
// Slices call it until it finds nothing to fill or the deadline comes; the routine is done when a call fills nothing.

import type { RoutineContext, RoutineOutcome } from '../routines'

const LIMIT = 500

export async function postingsBackfill(ctx: RoutineContext): Promise<RoutineOutcome> {
  let filled = Number(ctx.state?.filled ?? 0)
  let due = Number(ctx.state?.people_due ?? 0)
  while (ctx.now() < ctx.deadlineAt) {
    const { data, error } = await ctx.admin.rpc('backfill_posting_bodies', { p_limit: LIMIT })
    if (error) return { ok: false, failure: 'backfill_failed' }
    const r = (data ?? {}) as { filled?: number; people_due?: number }
    filled += r.filled ?? 0
    due += r.people_due ?? 0
    if (!r.filled) return { ok: true, found: { filled, people_due: due } }
  }
  return { ok: true, next: { filled, people_due: due } }
}
