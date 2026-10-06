// pnpm directory:add-links: T25, add by link on the owner's real careers links.
//
//   cd apps/web && pnpm directory:add-links --owner <your user id> --links my-20-links.json
//   add --no-record to print without writing the measure_runs row
//
// The file is a list of { "link": "https://retellai.com/careers", "expect": { "employer": "Retell AI" } } or
// { "link": "...", "expect": { "reason": "other_owner" } }: the right outcome for each link, written by you before the
// run. Each link goes through companies.add for your account, so an employer that is right IS added and followed, and
// a wrong employer would be too, which is what the measure counts. The bar is 20 of 20 and no wrong employer added.
// It reads and writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { readFileSync } from 'node:fs'
import { addLinksRun, recordMeasureRun, runAddLinks, type LinkCase } from '../lib/companies/directory-runs'
import { createAdminClient } from '../lib/harness/supabase-admin'

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
  if (!owner || !file) {
    console.error('directory:add-links: give --owner <user id> and --links <file>')
    process.exit(1)
  }
  const cases = JSON.parse(readFileSync(file, 'utf8')) as LinkCase[]
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
