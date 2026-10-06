/**
 * OWNER-RUN, ONCE. Moves the screenshots that were saved as data URLs on application attempts into
 * the private `attempts` bucket and points each row at its file. A JPEG up to 256 KB moves; anything
 * else stays a data URL (it is counted as "left"). Safe to run again: a moved row is skipped.
 *
 *   set -a && source /path/to/prod.env && set +a
 *   npx tsx scripts/move-attempt-images.ts
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY via lib/harness/supabase-admin.ts.
 */
import { moveDataUrlImages } from '../lib/applications/attempts'
import { createAdminClient } from '../lib/harness/supabase-admin'

async function main() {
  const admin = createAdminClient()
  let moved = 0
  let failed = 0
  // ponytail: rows that cannot move keep matching, so stop at the first pass that moves nothing
  for (;;) {
    const r = await moveDataUrlImages(admin, 200)
    moved += r.moved
    failed += r.failed
    if (r.moved === 0) {
      console.log(`moved ${moved}, left as data URLs ${r.left}, failed ${failed}`)
      return
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
