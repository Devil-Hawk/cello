// pnpm role-types:go-live: the owner turns the role type step on, or off.
//
//   cd apps/web && pnpm role-types:go-live --owner <your user id>          on, only after S2 passed on your labels
//   cd apps/web && pnpm role-types:go-live --owner <your user id> --off    off, always allowed
//
// --owner must equal OWNER_USER_ID. It writes with the service role (SUPABASE_URL, SUPABASE_SERVICE_KEY).

import { createAdminClient } from '../lib/harness/supabase-admin'
import { setRoleTypesLive } from '../lib/jobs/role-types/go-live'

async function main(): Promise<void> {
  const at = process.argv.indexOf('--owner')
  const owner = at >= 0 ? process.argv[at + 1] : undefined
  let admin
  try {
    admin = createAdminClient()
  } catch {
    console.error('role-types:go-live: no database credentials (set SUPABASE_URL and SUPABASE_SERVICE_KEY)')
    process.exit(1)
  }
  const result = await setRoleTypesLive(admin, { owner, on: !process.argv.includes('--off') })
  console.log(result.message)
  process.exit(result.ok ? 0 : 1)
}

main().catch(() => {
  console.error('role-types:go-live: failed')
  process.exit(1)
})
