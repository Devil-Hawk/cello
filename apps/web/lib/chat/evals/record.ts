// Records Chat's measures and says whether Chat may be shown.
//
//   pnpm tsx lib/chat/evals/record.ts ready                          prints the four gating measures, exits 1 until all pass
//   pnpm tsx lib/chat/evals/record.ts record S21 0.96 true 10 "note"  one measure_runs row (measure, value, passed, sample size, note)
//
// Chat is shown to everyone when S13, S14, S15 and S21 each have a latest run that passed. The owner then turns the
// chat_shown switch on; this script never does. It refuses to say "ready" while any of the four has no run or failed.

import type { AdminClient } from '@/lib/harness/types'
import type { S21Score } from './score'

export const CHAT_GATE = ['S13', 'S14', 'S15', 'S21'] as const

export interface MeasureRun {
  measure: string
  value: number | null
  passed: boolean | null
  sampleN: number | null
  note?: string
}

export async function recordMeasure(db: AdminClient, run: MeasureRun): Promise<boolean> {
  const { error } = await db.from('measure_runs').insert({ measure_id: run.measure, value: run.value, passed: run.passed, sample_n: run.sampleN, note: run.note ?? null })
  return !error
}

/** S21's run from its score: the share of parts right, passed only with no fact on the wrong object. */
export const recordS21 = (db: AdminClient, score: S21Score) =>
  recordMeasure(db, { measure: 'S21', value: score.share, passed: score.passed, sampleN: score.parts, note: `${score.wrongObjectFacts} facts on the wrong object` })

export interface Readiness {
  ready: boolean
  /** The latest run of each gating measure, null when it has none. */
  latest: { measure: string; passed: boolean | null; ranAt: string | null }[]
  sentence: string
}

export async function chatReady(db: AdminClient): Promise<Readiness> {
  const latest = await Promise.all(
    CHAT_GATE.map(async (measure) => {
      const { data } = await db.from('measure_runs').select('passed, ran_at').eq('measure_id', measure).order('ran_at', { ascending: false }).limit(1).maybeSingle()
      const row = data as { passed: boolean | null; ran_at: string } | null
      return { measure, passed: row ? row.passed : null, ranAt: row?.ran_at ?? null }
    })
  )
  const none = latest.filter((l) => l.ranAt === null).map((l) => l.measure)
  const failing = latest.filter((l) => l.ranAt !== null && l.passed !== true).map((l) => l.measure)
  const ready = none.length === 0 && failing.length === 0
  const sentence = ready
    ? 'Ready: S13, S14, S15 and S21 pass.'
    : `Not ready.${none.length ? ` No run yet: ${none.join(', ')}.` : ''}${failing.length ? ` Not passing: ${failing.join(', ')}.` : ''}`
  return { ready, latest, sentence }
}

async function main() {
  const { createAdminClient } = await import('@/lib/harness/supabase-admin')
  const db = createAdminClient()
  const [command, measure, value, passed, sampleN, note] = process.argv.slice(2)
  if (command === 'record' && measure) {
    const ok = await recordMeasure(db, { measure, value: value ? Number(value) : null, passed: passed ? passed === 'true' : null, sampleN: sampleN ? Number(sampleN) : null, note })
    console.log(ok ? `recorded ${measure}` : `could not record ${measure}`)
    process.exit(ok ? 0 : 1)
  }
  const r = await chatReady(db)
  for (const l of r.latest) console.log(`${l.measure}: ${l.ranAt === null ? 'no run' : l.passed ? 'passed' : 'not passing'}${l.ranAt ? ` (${l.ranAt})` : ''}`)
  console.log(r.sentence)
  process.exit(r.ready ? 0 : 1)
}

if (process.argv[1]?.endsWith('evals/record.ts')) void main()
