// pnpm directory:coverage: T24, the owner's real past employers against the directory's search.
//
//   cd apps/web && pnpm directory:coverage --names my-35-employers.txt      one name per line
//   cd apps/web && pnpm directory:coverage --owner <your user id>           the employers of your applications
//   add --no-record to print without writing the measure_runs row
//   cd apps/web && pnpm directory:coverage --find --names scripts/fixtures/t34-names.txt     T34, the real search ladder
//
// Each name goes through companies.search; it counts when the employer is among the first 3 verified rows. A miss says
// why. The bar is 34 of 35. It reads and writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).
//
// With --find each name goes through companies.find instead (the five rungs, the real network): it counts when a
// candidate for that employer is offered, and the row says which rung found it, how long it took, and for a miss how far
// it got. Nothing is written and nothing is recorded: a search writes nothing, and a web search that would be queued for
// the pull worker is only reported. Add --owner <user id> to use that person's own Tavily key; TAVILY_API_KEY also works.
// The names above a "# startups" line in the file are the owner's own: any miss among them exits 1. The names below it
// need 4 of every 5 (8 of 10). Lines starting with # are otherwise ignored.

import { readFileSync } from 'node:fs'
import { coverageRun, recordMeasureRun, runCoverage, runFinds } from '../lib/companies/directory-runs'
import { findEmployer, realFindDeps } from '../lib/companies/find'
import { createAdminClient } from '../lib/harness/supabase-admin'

const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

/** The distinct employers of a person's applications past "discovered", as the person sees them. */
async function namesOf(admin: ReturnType<typeof createAdminClient>, owner: string): Promise<string[]> {
  const { data: apps } = await admin.from('applications').select('job_id').eq('user_id', owner).in('stage', ['applied', 'screen', 'interview', 'offer'])
  const ids = ((apps ?? []) as { job_id: string | null }[]).map((a) => a.job_id).filter((id): id is string => !!id)
  const { data } = await admin.from('person_jobs').select('viewer_company_name').eq('viewer_id', owner).in('id', ids.slice(0, 500))
  return [...new Set(((data ?? []) as { viewer_company_name: string | null }[]).map((r) => r.viewer_company_name?.trim()).filter((n): n is string => !!n))]
}

async function main(): Promise<void> {
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('directory:coverage: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  const file = arg('--names')
  const owner = arg('--owner')
  if (!file && !owner) {
    console.error('directory:coverage: give --names <file> or --owner <user id>')
    process.exit(1)
  }
  const lines = file ? readFileSync(file, 'utf8').split(/\r?\n/) : await namesOf(admin, owner as string)
  const marker = lines.findIndex((l) => /^#\s*startups\b/i.test(l.trim()))
  const names = lines.filter((l) => !l.trim().startsWith('#'))
  const owned = (marker < 0 ? lines : lines.slice(0, marker)).filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length
  if (process.argv.includes('--find')) {
    const user = owner ?? '00000000-0000-0000-0000-000000000000'
    const deps = { ...realFindDeps(admin, owner ?? null), queue: async () => 'not queued by this script' }
    const run = await runFinds(names, (name, report) => findEmployer(admin, user, name, deps, report))
    for (const r of run.rows) console.log(`${r.hit ? 'found ' : 'MISS  '} ${r.name} [${r.hit ? 'rung' : 'reached'}: ${r.rung}, ${r.ms} ms] ${r.hit ? `-> ${r.found}` : `: ${r.reason}`}`)
    console.log(`\n${run.hits} of ${run.total} names offered as the right employer.`)
    // The bar: every name the owner gave, and 4 of every 5 of the startups (8 of 10).
    const ownedMisses = run.rows.slice(0, owned).filter((r) => !r.hit).length
    const startups = run.rows.slice(owned)
    const startupHits = startups.filter((r) => r.hit).length
    const startupBar = Math.ceil(startups.length * 0.8)
    console.log(`owner's names: ${owned - ownedMisses} of ${owned}; startups: ${startupHits} of ${startups.length} (need ${startupBar}).`)
    process.exit(ownedMisses > 0 || startupHits < startupBar ? 1 : 0)
  }
  const result = await runCoverage(admin, names)
  for (const r of result.rows) console.log(`${r.hit ? 'found ' : 'MISS  '} ${r.name}${r.hit ? ` -> ${r.found}` : `: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`}`)
  const run = coverageRun(result)
  console.log(`\n${run.note}`)
  if (!process.argv.includes('--no-record')) await recordMeasureRun(admin, 'T24', run)
  process.exit(run.passed === false ? 2 : 0)
}

main().catch((error) => {
  console.error(`directory:coverage: ${error instanceof Error ? error.message : 'failed'}`)
  process.exit(1)
})
