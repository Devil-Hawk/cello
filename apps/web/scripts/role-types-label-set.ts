// pnpm role-types:label-set: the 100 titles the owner marks, and the marked file as the Langfuse dataset S2 reads.
//
//   cd apps/web && pnpm role-types:label-set --owner <your user id> [--out role-types-labels.csv]
//       writes 100 titles from your kept roles and applications; fill the your_type column
//       with a role type id (or none), then
//   cd apps/web && pnpm role-types:label-set --import role-types-labels.csv
//       sends the marked rows to the dataset `role-types` (LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY)
//
// --owner must equal OWNER_USER_ID. Reading uses the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { readFileSync, writeFileSync } from 'node:fs'
import { createAdminClient } from '../lib/harness/supabase-admin'
import { isOwner } from '../lib/measures/owner'
import { collectLabelRows, importLabelSet, labelSetCsv, parseLabelCsv } from '../lib/jobs/role-types/label-set'

const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

async function main(): Promise<void> {
  const file = arg('--import')
  if (file) {
    const { labelled, refused } = parseLabelCsv(readFileSync(file, 'utf8'))
    for (const r of refused) console.error(`refused: ${r}`)
    const out = await importLabelSet(labelled)
    console.log(`${out.imported} marked titles sent to the dataset role-types`)
    process.exit(refused.length > 0 ? 1 : 0)
  }

  const owner = arg('--owner')
  if (!isOwner(owner)) {
    console.error('role-types:label-set: --owner must be the instance owner (OWNER_USER_ID)')
    process.exit(1)
  }
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('role-types:label-set: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  const rows = await collectLabelRows(admin, owner as string)
  const out = arg('--out') ?? 'role-types-labels.csv'
  writeFileSync(out, labelSetCsv(rows))
  console.log(`${rows.length} titles written to ${out}. Fill the your_type column, then run with --import.`)
  process.exit(0)
}

main().catch((error) => {
  console.error(`role-types:label-set: ${error instanceof Error ? error.message : 'failed'}`)
  process.exit(1)
})
