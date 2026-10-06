// owner.health: daily, runs every measure that is computed from the database (the T layer) and
// writes a measure_runs row for each. The measures and run_true_measures() arrive with the
// scorecard (migration 20261008045000); until they exist this only records that it ran.

import type { RoutineContext, RoutineOutcome } from '../routines'

export async function ownerHealth(ctx: RoutineContext): Promise<RoutineOutcome> {
  const { data, error } = await ctx.admin.rpc('run_true_measures')
  if (error) {
    // 42883 and PGRST202: the function does not exist yet on this database.
    if (error.code === '42883' || error.code === 'PGRST202') return { ok: true, found: { measures: 0 } }
    return { ok: false, failure: 'run_true_measures' }
  }
  const rows = Array.isArray(data) ? data : []
  return { ok: true, found: { measures: rows.length } }
}
