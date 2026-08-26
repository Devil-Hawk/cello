// Refresh lib/evals/fixtures/retrieval.golden.json's chunk CONTENT from the
// live kb_chunks table, by id. Owner-run — never executed by this stage.
//
//   pnpm tsx scripts/snapshot-retrieval-eval.ts
//
// WHY THIS SCRIPT DOES NOT WRITE query/relevant LABELS
//   scripts/snapshot-eval-data.ts can derive its labels straight from
//   behavior: `applications` is ground truth — a human genuinely applied or
//   didn't. There is no equivalent table for KB retrieval (nothing records
//   "the user searched X and the chunk that mattered was Y"), so which chunk
//   is relevant to which query is a human judgment call, not a fact this
//   script can read off the database. What CAN drift is the CONTENT of an
//   already-curated chunk — dossiers get re-synthesized, resumes get
//   re-pasted — so this script's only job is: for every chunk id already in
//   the committed fixture, pull its current `content` from kb_chunks and
//   overwrite it in place. The query/relevant judgments a human wrote are
//   left completely untouched.
//
// WHAT HAPPENS TO AN ID THAT NO LONGER EXISTS
//   Reported and left as-is (not deleted) — a human decides whether that
//   query still needs a fixture at all; this script does not restructure the
//   fixture's shape, only refresh text within it.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(process.cwd(), 'lib/evals/fixtures/retrieval.golden.json')

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

interface GoldenChunk {
  id: string
  content: string
  relevant: boolean
}
interface GoldenQuery {
  query: string
  chunks: GoldenChunk[]
}
interface GoldenFixture {
  note: string
  cases: GoldenQuery[]
}
interface KbChunkRow {
  id: string
  content: string
}

async function main() {
  const fixture = JSON.parse(readFileSync(OUT, 'utf8')) as GoldenFixture
  const allIds = fixture.cases.flatMap((q) => q.chunks.map((c) => c.id))

  // These fixture ids are synthetic (c1, c2, ... — hand-authored content, not
  // real kb_chunks rows), so a real refresh finds none of them. That is
  // EXPECTED today and this script still runs cleanly: the moment someone
  // curates a query against a REAL chunk id from kb_chunks, this pass starts
  // refreshing it. Left in place (not stubbed out) so it is exercised, not
  // just described.
  const rows = await rest<KbChunkRow[]>(`kb_chunks?select=id,content&id=in.(${allIds.map((id) => `"${id}"`).join(',')})`)
  const byId = new Map(rows.map((r) => [r.id, r.content]))

  let refreshed = 0
  let missing = 0
  for (const q of fixture.cases) {
    for (const c of q.chunks) {
      const live = byId.get(c.id)
      if (live === undefined) {
        missing++
        continue
      }
      if (live !== c.content) {
        c.content = live
        refreshed++
      }
    }
  }

  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n')
  console.log(`wrote ${OUT}`)
  console.log(`  chunks refreshed from kb_chunks: ${refreshed}`)
  console.log(`  chunk ids not found in kb_chunks (left as hand-authored text): ${missing}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
