// pnpm scorecard: prints every measure with its bar, its latest number and its date, failing first.
//
//   cd apps/web && pnpm scorecard            the table
//   cd apps/web && pnpm scorecard --json     the rows as JSON
//
// It reads with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY), so whoever can run it is the
// instance owner. Nothing is written.

import { createAdminClient } from '../lib/harness/supabase-admin'
import { formatScorecard } from '../lib/measures/format'
import { loadScorecard } from '../lib/measures/scorecard'

async function main(): Promise<void> {
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('scorecard: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  const rows = await loadScorecard(admin)
  console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : formatScorecard(rows))
  process.exit(0)
}

main().catch((error) => {
  console.error(`scorecard: ${error instanceof Error ? error.name : 'failed'}`)
  process.exit(1)
})
