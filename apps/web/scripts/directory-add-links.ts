// pnpm directory:add-links: T25, add by link on the owner's real careers links.
//
//   cd apps/web && pnpm directory:add-links --owner <your user id> --links my-20-links.json
//   cd apps/web && pnpm directory:add-links --owner <your user id> --named --links scripts/fixtures/t25-more-links.json
//   add --no-record to print without writing the measure_runs row
//   add --named to start from the cases that must hold (below); --links is then optional
//
// The file is a list of { "link": "https://retellai.com/careers", "expect": { "employer": "Retell AI" } } or
// { "link": "...", "expect": { "reason": "other_owner" } }: the right outcome for each link, written by you before the
// run. Each link goes through companies.add for your account, so an employer that is right IS added and followed, and
// a wrong employer would be too, which is what the measure counts. The bar is 20 of 20 and no wrong employer added.
// It reads and writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { readFileSync } from 'node:fs'
import { addLinksRun, recordMeasureRun, runAddLinks, type LinkCase } from '../lib/companies/directory-runs'
import { createAdminClient } from '../lib/harness/supabase-admin'

/** The cases that must hold whatever else is in the list (Part 1, section 1.8). */
const NAMED: LinkCase[] = [
  // another employer's board under a big name
  { link: 'https://amazon.jobs.personio.de/', expect: { reason: 'other_owner' } },
  // the site links the board and Ashby declares retellai.com
  { link: 'retellai.com/careers', expect: { employer: 'Retell AI' } },
  // boards checked by hand: their pages link them only through script
  { link: 'datadoghq.com/careers', expect: { employer: 'Datadog' } },
  { link: 'ramp.com/careers', expect: { employer: 'Ramp' } },
  // an applicant system that keeps no record of its owner, on a name no big employer has
  { link: 'https://pfizer.wd1.myworkdayjobs.com/PfizerCareers', expect: { employer: 'Pfizer' } },
  // a job site is not the employer; its offer is the employer's own posting when the page names one
  { link: 'https://www.linkedin.com/jobs/view/3912345678', expect: { reason: 'not_employer_site' } },
]

const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

async function main(): Promise<void> {
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('directory:add-links: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  const owner = arg('--owner')
  const file = arg('--links')
  const named = process.argv.includes('--named')
  if (!owner || (!file && !named)) {
    console.error('directory:add-links: give --owner <user id> and --links <file> or --named')
    process.exit(1)
  }
  const cases = [...(named ? NAMED : []), ...(file ? (JSON.parse(readFileSync(file, 'utf8')) as LinkCase[]) : [])]
  if (!Array.isArray(cases) || cases.some((c) => typeof c?.link !== 'string' || !c.expect)) {
    console.error('directory:add-links: the file must be a list of { link, expect }')
    process.exit(1)
  }
  const result = await runAddLinks(admin, owner, cases)
  for (const r of result.rows) console.log(`${r.ok ? 'ok   ' : 'WRONG'} ${r.link} -> ${r.got}${r.offers ? ` (${r.offers} offers)` : ''}`)
  const run = addLinksRun(result)
  console.log(`\n${run.note}`)
  if (!process.argv.includes('--no-record')) await recordMeasureRun(admin, 'T25', run)
  process.exit(run.passed === false ? 2 : 0)
}

main().catch((error) => {
  console.error(`directory:add-links: ${error instanceof Error ? error.message : 'failed'}`)
  process.exit(1)
})
