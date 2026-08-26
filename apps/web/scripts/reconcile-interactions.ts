/**
 * OWNER-RUN, READ-ONLY. Reports source rows that SHOULD have a
 * public.interactions projection (by the same eligibility rules
 * scripts/backfill-interactions.ts uses) but don't — drift between the live
 * write paths / the backfill and the timeline they're supposed to keep in
 * sync. NEVER WRITES. A gap here means one of:
 *   - the backfill hasn't been run yet (run it, then re-run this)
 *   - a live write path's recordInteraction call is failing silently
 *     (check logs for "[interactions] recordInteraction failed")
 *   - a live write path's own gate (e.g. recordStageActivity's) has drifted
 *     from isTimelineEligibleActivity, which this script imports from
 *     backfill-interactions.ts rather than restating
 * Whichever it is, a human decides the fix — this script only surfaces it.
 *
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/reconcile-interactions.ts                # summary counts
 *   npx tsx scripts/reconcile-interactions.ts --show 20       # + up to 20 sample ids per source
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) via lib/harness/supabase-admin.ts#createAdminClient().
 */
import { createAdminClient } from '../lib/harness/supabase-admin'
import { isTimelineEligibleActivity } from './backfill-interactions'

type Admin = ReturnType<typeof createAdminClient>

const READ_PAGE = 500

function parseArgs(argv: string[]) {
  const showIdx = argv.indexOf('--show')
  return { show: showIdx > -1 && argv[showIdx + 1] ? Number(argv[showIdx + 1]) : 0 }
}

/** ref_ids in `ids` that ALREADY have an interactions row for ref_table (any kind). */
async function alreadyProjected(admin: Admin, refTable: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data, error } = await admin.from('interactions').select('ref_id').eq('ref_table', refTable).in('ref_id', ids)
  if (error) throw new Error(`check interactions for ${refTable}: ${error.message}`)
  return new Set(((data ?? []) as { ref_id: string }[]).map((r) => r.ref_id))
}

interface Drift {
  missing: string[]
}

async function reconcileOutreach(admin: Admin): Promise<Drift> {
  const missing: string[] = []
  let cursor: string | null = null
  for (;;) {
    let q = admin.from('outreach_messages').select('id').eq('status', 'sent').order('id', { ascending: true }).limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load outreach_messages: ${error.message}`)
    const rows = (data ?? []) as { id: string }[]
    if (rows.length === 0) break
    const projected = await alreadyProjected(admin, 'outreach_messages', rows.map((r) => r.id))
    for (const r of rows) if (!projected.has(r.id)) missing.push(r.id)
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE) break
  }
  return { missing }
}

async function reconcileActivities(admin: Admin): Promise<Drift> {
  const missing: string[] = []
  let cursor: string | null = null
  for (;;) {
    let q = admin
      .from('activities')
      .select('id, type, metadata')
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load activities: ${error.message}`)
    const rows = (data ?? []) as { id: string; type: string; metadata: Record<string, unknown> | null }[]
    if (rows.length === 0) break
    const eligible = rows.filter(isTimelineEligibleActivity)
    const projected = await alreadyProjected(admin, 'activities', eligible.map((r) => r.id))
    for (const r of eligible) if (!projected.has(r.id)) missing.push(r.id)
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE) break
  }
  return { missing }
}

async function reconcileFollowUps(admin: Admin): Promise<Drift> {
  const missing: string[] = []
  let cursor: string | null = null
  for (;;) {
    let q = admin.from('follow_ups').select('id').eq('is_completed', true).order('id', { ascending: true }).limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load follow_ups: ${error.message}`)
    const rows = (data ?? []) as { id: string }[]
    if (rows.length === 0) break
    const projected = await alreadyProjected(admin, 'follow_ups', rows.map((r) => r.id))
    for (const r of rows) if (!projected.has(r.id)) missing.push(r.id)
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE) break
  }
  return { missing }
}

async function reconcileReceipts(admin: Admin): Promise<Drift> {
  const missing: string[] = []
  let cursor: string | null = null
  for (;;) {
    let q = admin.from('application_receipts').select('id').order('id', { ascending: true }).limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load application_receipts: ${error.message}`)
    const rows = (data ?? []) as { id: string }[]
    if (rows.length === 0) break
    const projected = await alreadyProjected(admin, 'application_receipts', rows.map((r) => r.id))
    for (const r of rows) if (!projected.has(r.id)) missing.push(r.id)
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE) break
  }
  return { missing }
}

function report(label: string, d: Drift, show: number): void {
  console.log(`${label.padEnd(20)}: ${d.missing.length} missing projection${d.missing.length === 1 ? '' : 's'}`)
  if (show > 0 && d.missing.length > 0) console.log(`  ${d.missing.slice(0, show).join(', ')}`)
}

async function main(): Promise<void> {
  const { show } = parseArgs(process.argv.slice(2))
  console.log('reconcile-interactions (read-only — reports drift, fixes nothing)')
  console.log('')

  const admin = createAdminClient()
  report('outreach_messages', await reconcileOutreach(admin), show)
  report('activities', await reconcileActivities(admin), show)
  report('follow_ups', await reconcileFollowUps(admin), show)
  report('application_receipts', await reconcileReceipts(admin), show)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
