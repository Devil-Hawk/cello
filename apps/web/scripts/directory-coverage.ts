// pnpm directory:coverage: T24, the owner's real past employers against the directory's search.
//
//   cd apps/web && pnpm directory:coverage --names my-35-employers.txt      one name per line
//   cd apps/web && pnpm directory:coverage --owner <your user id>           the employers of your applications
//   add --no-record to print without writing the measure_runs row
//
// Each name goes through companies.search; it counts when the employer is among the first 3 verified rows. A miss says
// why. The bar is 34 of 35. It reads and writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { readFileSync } from 'node:fs'
import { coverageRun, recordMeasureRun, runCoverage } from '../lib/companies/directory-runs'
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
  const names = file ? readFileSync(file, 'utf8').split(/\r?\n/) : await namesOf(admin, owner as string)
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
