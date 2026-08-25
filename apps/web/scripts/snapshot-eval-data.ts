// Snapshot the labelled match-scorer dataset from the live database into a
// committed golden fixture.
//
//   pnpm tsx scripts/snapshot-eval-data.ts
//
// WHY A SNAPSHOT AND NOT A LIVE QUERY
//   Evals must run in CI, where there is no database, and must be deterministic
//   so a red build means a real regression rather than yesterday's data moving.
//   Committing the fixture also makes a dataset change a reviewable diff
//   instead of an invisible shift under the tests.
//
// WHY DEMO ROWS ARE EXCLUDED HERE AND NOT IN THE EVAL
//   The first run of this analysis found 16 of 17 "applications" were demo rows
//   seeded by deliberately picking the HIGHEST-scoring jobs. Ranking evals over
//   that would have reported near-perfect separation while measuring nothing
//   but how the seed script was written — the most dangerous kind of green
//   test. The filter lives at the snapshot boundary so contaminated rows never
//   enter the fixture at all; an eval reading the fixture cannot forget to
//   apply it.

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const DEMO_MARKER = '[cello-demo-seed]'
const OUT = path.resolve(process.cwd(), 'lib/evals/fixtures/match-scorer.golden.json')
/** How many never-applied scored jobs to sample as negatives. */
const NEGATIVE_SAMPLE = 400

function env(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`${key} is required`)
  return v
}

const BASE = env('SUPABASE_URL')
const KEY = env('SUPABASE_SERVICE_KEY')

async function rest<T>(query: string): Promise<T> {
  const res = await fetch(`${BASE}/rest/v1/${query}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  })
  if (!res.ok) throw new Error(`${query} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

interface AppRow {
  job_id: string
  notes: string | null
  stage: string
  jobs: { match_score: number | null; title: string } | null
}
interface JobRow {
  id: string
  title: string
  match_score: number | null
}

async function main() {
  const apps = await rest<AppRow[]>(
    'applications?select=job_id,notes,stage,jobs(match_score,title)&limit=500'
  )

  // Positives: jobs the human actually applied to, EXCLUDING seeded demo rows.
  const genuine = apps.filter((a) => !(a.notes ?? '').includes(DEMO_MARKER))
  const positives = genuine
    .filter((a) => a.jobs?.match_score != null)
    .map((a) => ({
      id: a.job_id,
      score: a.jobs!.match_score as number,
      positive: true,
      label: `${a.jobs!.title} (${a.stage})`,
    }))

  // Negatives: scored jobs the human never applied to.
  const appliedIds = new Set(apps.map((a) => a.job_id))
  const sampled = await rest<JobRow[]>(
    `jobs?select=id,title,match_score&match_score=not.is.null&order=match_score.desc&limit=${NEGATIVE_SAMPLE}`
  )
  const negatives = sampled
    .filter((j) => !appliedIds.has(j.id) && j.match_score != null)
    .map((j) => ({ id: j.id, score: j.match_score as number, positive: false, label: j.title }))

  const fixture = {
    // No generatedAt timestamp: it would make every regeneration a diff even
    // when the data is identical, which trains people to skim the review.
    note:
      'Labelled match-scorer data snapshotted from production. Positives are jobs the user ' +
      'genuinely applied to (demo-seeded rows excluded at snapshot time). Negatives are scored ' +
      'jobs never applied to. Regenerate: pnpm tsx scripts/snapshot-eval-data.ts',
    excludedDemoRows: apps.length - genuine.length,
    cases: [...positives, ...negatives],
  }

  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')

  console.log(`wrote ${OUT}`)
  console.log(`  positives (genuine applications): ${positives.length}`)
  console.log(`  negatives (never applied)       : ${negatives.length}`)
  console.log(`  demo rows excluded              : ${fixture.excludedDemoRows}`)
  if (positives.length < 10) {
    console.log(
      `\n  NOTE: ${positives.length} genuine positive(s). The ranking eval will report ` +
        `insufficient-data until this reaches 10 — that refusal is deliberate.`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
