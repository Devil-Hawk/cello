// suggestions.refresh: each person's "Suggested for you", rebuilt once a day, in slices.
//
// A slice rebuilds the lists that are due (never-built first, a few people at a time, none started after the
// deadline). While people are still due it hands on to the next slice, so a day's pass reaches everyone without a
// request waiting for it. The list is only ever read by a page, never computed by one.

import { refreshDueSuggestions, type DueResult } from '../../companies/refresh'
import type { RoutineContext, RoutineOutcome } from '../routines'

/** A day's pass stops after this many slices even if people are still due; the next day's pass takes them first. */
export const MAX_ROUNDS = 50

export async function suggestionsRefreshWith(ctx: RoutineContext, refresh: (admin: RoutineContext['admin'], opts: { deadlineAt: number }) => Promise<DueResult>): Promise<RoutineOutcome> {
  const r = await refresh(ctx.admin, { deadlineAt: ctx.deadlineAt })
  const rounds = Number(ctx.state?.rounds ?? 0) + 1
  const more = r.skipped > 0 && r.refreshed + r.failed > 0 && rounds < MAX_ROUNDS
  return { ok: true, found: { ...r }, ...(more ? { next: { rounds } } : {}) }
}

export const suggestionsRefresh = (ctx: RoutineContext): Promise<RoutineOutcome> => suggestionsRefreshWith(ctx, refreshDueSuggestions)
