// The scorecard: every measure of the register with its latest run, failing rows first.
//
// A measure that has no run reads "No run yet", never a pass. A failing number is shown as failing.
// The known failures of 2026-10-05 are pinned as runs whose note starts with "Pinned"; they stay
// visible after a later run replaces the number, so the page keeps saying what was never proven.

import type { SupabaseClient } from '@supabase/supabase-js'
import { isOwner } from './owner'
import type { MeasureLayer } from './register'

type Db = SupabaseClient<any, any, any>

export interface MeasureRow {
  id: string
  layer: MeasureLayer
  name: string
  bar: string
  direction: string | null
  source: string | null
  gates: string[]
  state: 'watch' | 'gating'
}

export interface RunRow {
  measure_id: string
  ran_at: string
  value: number | string | null
  passed: boolean | null
  sample_n: number | null
  note: string | null
}

export type Status = 'failing' | 'passing' | 'no_run'

export interface ScorecardRow extends MeasureRow {
  status: Status
  latest: { ranAt: string; value: number | null; passed: boolean | null; sampleN: number | null; note: string | null } | null
  /** The run before the latest, for the trend. */
  previousValue: number | null
  trend: 'rising' | 'falling' | 'flat' | null
  /** A known failure that stays on the page: the note of the pinned run. */
  pinned: string | null
}

export const PINNED_PREFIX = 'Pinned'

const LAYER_ORDER: Record<string, number> = { true: 0, step: 1, person: 2 }

/** T2 before T10: the number in the id, not the text. */
function idOrder(a: string, b: string): number {
  const [la, na] = [a[0], Number(a.slice(1))]
  const [lb, nb] = [b[0], Number(b.slice(1))]
  return la === lb ? na - nb : la < lb ? -1 : 1
}

const num = (v: number | string | null): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** Pure: runs are any order; the result is failing first, then measures with no run, then passing, each in register order. */
export function buildScorecard(measures: MeasureRow[], runs: RunRow[]): ScorecardRow[] {
  const byMeasure = new Map<string, RunRow[]>()
  for (const r of runs) byMeasure.set(r.measure_id, [...(byMeasure.get(r.measure_id) ?? []), r])

  const rows = measures.map((m): ScorecardRow => {
    const mine = (byMeasure.get(m.id) ?? []).sort((a, b) => Date.parse(b.ran_at) - Date.parse(a.ran_at))
    const latest = mine[0] ?? null
    const previous = mine[1] ?? null
    const value = latest ? num(latest.value) : null
    const prevValue = previous ? num(previous.value) : null
    const trend = value !== null && prevValue !== null ? (value > prevValue ? 'rising' : value < prevValue ? 'falling' : 'flat') : null
    const pinned = mine.find((r) => r.note?.startsWith(PINNED_PREFIX))?.note ?? null
    const status: Status = !latest || latest.passed === null ? 'no_run' : latest.passed ? 'passing' : 'failing'
    return {
      ...m,
      status,
      latest: latest ? { ranAt: latest.ran_at, value, passed: latest.passed, sampleN: latest.sample_n, note: latest.note } : null,
      previousValue: prevValue,
      trend,
      pinned,
    }
  })

  const rank: Record<Status, number> = { failing: 0, no_run: 1, passing: 2 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || (LAYER_ORDER[a.layer] ?? 9) - (LAYER_ORDER[b.layer] ?? 9) || idOrder(a.id, b.id))
}

/** Reads the register and the latest runs. Needs the service role: the tables grant nothing to a session. */
export async function loadScorecard(admin: Db): Promise<ScorecardRow[]> {
  const [measures, runs, pinned] = await Promise.all([
    admin.from('measures').select('id, layer, name, bar, direction, source, gates, state'),
    // The most recent runs: 68 measures, a few runs each. Older runs are not needed for the latest and the trend.
    admin.from('measure_runs').select('measure_id, ran_at, value, passed, sample_n, note').order('ran_at', { ascending: false }).limit(1500),
    admin.from('measure_runs').select('measure_id, ran_at, value, passed, sample_n, note').like('note', `${PINNED_PREFIX}%`),
  ])
  if (measures.error) throw new Error('measures')
  if (runs.error) throw new Error('measure_runs')
  const all = new Map<string, RunRow>()
  for (const r of [...((runs.data ?? []) as RunRow[]), ...((pinned.data ?? []) as RunRow[])]) all.set(`${r.measure_id}|${r.ran_at}|${r.note ?? ''}`, r)
  return buildScorecard((measures.data ?? []) as MeasureRow[], [...all.values()])
}

/** owner.scorecard: the rows for the owner, null for anyone else (the wrapper answers 404). */
export async function ownerScorecard(ctx: { userId: string | null | undefined; admin: Db; env?: { OWNER_USER_ID?: string } }): Promise<ScorecardRow[] | null> {
  if (!isOwner(ctx.userId, ctx.env)) return null
  return loadScorecard(ctx.admin)
}
