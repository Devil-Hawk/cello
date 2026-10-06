// pnpm role-types:sync: write the role_types table from lib/jobs/role-types (the one taxonomy).
//
//   cd apps/web && pnpm role-types:sync            write it
//   cd apps/web && pnpm role-types:sync --check    say which ids differ; exit 1 when any do
//
// It writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { createAdminClient } from '../lib/harness/supabase-admin'
import { diffRoleTypes, syncRoleTypes } from '../lib/jobs/role-types/sync'

async function main(): Promise<void> {
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('role-types:sync: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  if (process.argv.includes('--check')) {
    const { data, error } = await admin.from('role_types').select('id, label, family, related, taxonomy_version, retired_at')
    if (error) throw new Error('read failed')
    const differ = diffRoleTypes((data ?? []) as never)
    console.log(differ.length === 0 ? 'role_types equals the module' : `role_types differs from the module: ${differ.join(', ')}`)
    process.exit(differ.length === 0 ? 0 : 1)
  }
  const out = await syncRoleTypes(admin)
  console.log(`role_types: ${out.written} written${out.retired.length ? `, retired: ${out.retired.join(', ')}` : ''}`)
  process.exit(0)
}

main().catch((error) => {
  console.error(`role-types:sync: ${error instanceof Error ? error.message : 'failed'}`)
  process.exit(1)
})
