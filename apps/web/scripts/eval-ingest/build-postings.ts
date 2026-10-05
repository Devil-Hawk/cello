// Build postings.json, the requirements eval set, from real postings in a local
// database: 30 postings of 400+ characters the deterministic parser could not
// split (so a model would be asked), 5 blurbs, chosen by a fixed hash so the same
// database gives the same set. Also prints how much of the 400+ character
// postings the parser resolves on its own.
//
//   cd apps/web && npx tsx scripts/eval-ingest/build-postings.ts
//
// Reads with psql (EVAL_DB_URL, default the local Supabase). Writes nothing else.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseRequirements, needsModel } from '../../lib/jobs/requirements'

const DB = process.env.EVAL_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const OUT = path.join(__dirname, 'postings.json')
const MAX_CHARS = 6000

interface Row {
  id: string
  title: string
  description: string
  location: string | null
  salary_range: string | null
  source: string | null
}

function query(sql: string): Row[] {
  const out = execFileSync('psql', [DB, '-At', '-c', `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`], {
    encoding: 'utf8',
    maxBuffer: 200_000_000,
  })
  return JSON.parse(out.trim())
}

const rows = query(
  `select id, title, description, location, salary_range, source from jobs
   where length(description) >= 100 and source in ('greenhouse','lever','ashby','workable','smartrecruiters','workday','scraper')
   order by md5(id::text)`
)

const parsed = rows.map((r) => ({ r, req: parseRequirements({ title: r.title, description: r.description, location: r.location, salaryRange: r.salary_range }) }))
const long = parsed.filter((p) => p.r.description.length >= 400)
const resolved = long.filter((p) => !needsModel(p.req, p.r.description))
const unresolved = long.filter((p) => needsModel(p.req, p.r.description))
// Blurbs: what a posting looks like when it says nothing about what it asks. The
// shortest real ones in the database (a company one-liner, a Hacker News header),
// plus one written for this set.
const shortRows = query(
  `select id, title, description, location, salary_range, source from jobs
   where length(description) between 60 and 399 and source is not null order by md5(id::text)`
)
const WRITTEN_BLURBS: Row[] = [{
  id: 'written-1',
  title: 'Customer Success Manager',
  description:
    'Northwind Labs is a logistics software company with offices in Chicago and Lisbon. We are growing quickly and hiring across many teams. Our people care about craft, customers and each other. Come and build something meaningful with us.',
  location: null,
  salary_range: null,
  source: 'written',
}, {
  id: 'written-2',
  title: 'Operations Associate',
  description:
    'Brightline helps independent pharmacies keep their shelves stocked. The team is small and works from a sunny office in Denver. If you like the idea of helping local businesses thrive, we would love to hear from you.',
  location: 'Denver, CO',
  salary_range: null,
  source: 'written',
}]
const blurbs = [...shortRows, ...WRITTEN_BLURBS].slice(0, 5).map((r) => ({
  r,
  req: parseRequirements({ title: r.title, description: r.description, location: r.location, salaryRange: r.salary_range }),
}))

console.log(
  JSON.stringify({
    postingsOf400PlusChars: long.length,
    resolvedByParser: resolved.length,
    deterministicCoverage: Number((resolved.length / long.length).toFixed(3)),
    needingModel: unresolved.length,
    blurbs: blurbs.length,
  })
)

// A spread across sources, not thirty from the largest board.
const bySource = new Map<string, typeof unresolved>()
for (const p of unresolved) bySource.set(p.r.source ?? 'unknown', [...(bySource.get(p.r.source ?? 'unknown') ?? []), p])
const picked: typeof unresolved = []
for (let round = 0; picked.length < 30; round++) {
  let added = false
  for (const list of bySource.values()) {
    if (list[round] && picked.length < 30) {
      picked.push(list[round])
      added = true
    }
  }
  if (!added) break
}

const item = (p: (typeof parsed)[number], kind: 'prose' | 'blurb') => ({
  id: p.r.id.slice(0, 8),
  kind,
  title: p.r.title,
  source: p.r.source,
  description: p.r.description.slice(0, MAX_CHARS),
})
writeFileSync(OUT, JSON.stringify([...picked.map((p) => item(p, 'prose')), ...blurbs.map((p) => item(p, 'blurb'))], null, 1) + '\n')
console.log(JSON.stringify({ wrote: path.basename(OUT), prose: picked.length, blurbs: blurbs.length }))
