/**
 * OWNER-RUN. Projects every pre-existing source row that STEP 5's live write
 * paths (lib/outreach/store.ts#updateOutreach, lib/gmail/activity.ts
 * #recordStageActivity, lib/applications/store.ts#createReceipt) now project
 * going forward, onto public.interactions — so the unified timeline covers
 * history, not just whatever happens after this migration lands. Four
 * sources, one kind each:
 *
 *   outreach_messages (status='sent')        -> outreach_sent
 *   activities (interview/stage-advance rows) -> interview | stage_change
 *   follow_ups (is_completed=true)            -> follow_up_done
 *   application_receipts (every row)          -> application_submitted
 *
 * follow_ups HAS NO LIVE WRITER: nothing in this codebase currently sets
 * is_completed=true (no "mark done" action exists yet), so there is no
 * source-store function to wire a projection into — same reasoning that
 * defers reply_received to stage 3, applied here instead of scaffolding an
 * unused completion mutation. Rows CAN already exist with is_completed=true
 * (seed data, a direct DB write), so backfilling them is still real work;
 * whichever function eventually marks a follow-up done wires the live
 * projection in when it lands.
 *
 * IDEMPOTENT BY THE SAME KEY THE LIVE PATH USES: every projection goes
 * through lib/interactions/store.ts#recordInteraction, which upserts on
 * (ref_table, ref_id, kind) — the exact key recordStageActivity/
 * updateOutreach/createReceipt already write under. A second run of this
 * script (or a live write racing it for the same source row) updates the
 * same interactions row instead of duplicating it; it is therefore also safe
 * to run AFTER the live paths are already deployed and producing new rows.
 *
 * THE activities SOURCE MIRRORS recordStageActivity's OWN GATE, NOT A GUESS:
 * an interview_scheduled activity always projects (kind='interview' — a
 * second interview invite while already in that stage is still real news,
 * see that function's own comment). Every other type projects ONLY when the
 * row's own metadata.stage_decision.action === 'advanced' — reproducing,
 * from stored history, the same "ignored regression/terminal/no-op email
 * never reaches the timeline" rule the live gate enforces. A pre-port
 * activities row with no stage_decision in its metadata (nothing in this
 * codebase ever wrote one before the Gmail sync/share rewrite) has no
 * signal to reproduce that rule from and is SKIPPED, counted separately —
 * never guessed at.
 *
 *   set -a && source /path/to/prod.env && set +a
 *
 *   npx tsx scripts/backfill-interactions.ts                 # dry run (default)
 *   npx tsx scripts/backfill-interactions.ts --apply          # write
 *   npx tsx scripts/backfill-interactions.ts --apply --limit 200   # smoke test (rows per source)
 *
 * CONNECTION: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (SUPABASE_SERVICE_KEY
 *   also accepted) via lib/harness/supabase-admin.ts#createAdminClient() —
 *   the same service-role credentials every other apps/web/scripts/*.ts
 *   owner-run script uses (see scripts/backfill-company-identity.ts).
 */
import { createAdminClient } from '../lib/harness/supabase-admin'
import { recordInteraction, type InteractionKind } from '../lib/interactions/store'

type Admin = ReturnType<typeof createAdminClient>

const READ_PAGE = 500

function parseArgs(argv: string[]) {
  const limitIdx = argv.indexOf('--limit')
  return {
    apply: argv.includes('--apply'),
    limit: limitIdx > -1 && argv[limitIdx + 1] ? Number(argv[limitIdx + 1]) : null,
  }
}

interface Counts {
  eligible: number
  written: number
  skipped: number
}

export async function backfillOutreach(admin: Admin, apply: boolean, limit: number | null): Promise<Counts> {
  const counts: Counts = { eligible: 0, written: 0, skipped: 0 }
  let cursor: string | null = null
  for (;;) {
    let q = admin
      .from('outreach_messages')
      .select('id, user_id, company_id, contact_id, job_id, subject, kind, to_email, sent_at, updated_at')
      .eq('status', 'sent')
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load outreach_messages: ${error.message}`)
    const rows = (data ?? []) as {
      id: string; user_id: string; company_id: string | null; contact_id: string | null; job_id: string | null
      subject: string; kind: string; to_email: string; sent_at: string | null; updated_at: string
    }[]
    if (rows.length === 0) break
    for (const r of rows) {
      if (limit && counts.eligible >= limit) break
      counts.eligible++
      if (apply) {
        await recordInteraction(admin, {
          userId: r.user_id,
          companyId: r.company_id,
          contactId: r.contact_id,
          jobId: r.job_id,
          kind: 'outreach_sent',
          occurredAt: r.sent_at ?? r.updated_at,
          title: `Outreach sent — ${r.subject}`,
          refTable: 'outreach_messages',
          refId: r.id,
          metadata: { kind: r.kind, to_email: r.to_email },
        })
        counts.written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && counts.eligible >= limit)) break
  }
  return counts
}

interface StageDecisionMeta {
  action?: string
}

/**
 * The activities row is timeline-worthy: an interview invite always is; any
 * other type only when its own stored stage_decision says 'advanced' — the
 * one rule scripts/reconcile-interactions.ts must reproduce exactly rather
 * than drift from, so both scripts call this instead of each writing it out.
 */
export function isTimelineEligibleActivity(r: {
  type: string
  metadata: Record<string, unknown> | null
}): boolean {
  if (r.type === 'interview_scheduled') return true
  const decision = (r.metadata?.stage_decision ?? null) as StageDecisionMeta | null
  return decision?.action === 'advanced'
}

export async function backfillActivities(admin: Admin, apply: boolean, limit: number | null): Promise<Counts> {
  const counts: Counts = { eligible: 0, written: 0, skipped: 0 }
  let cursor: string | null = null
  for (;;) {
    let q = admin
      .from('activities')
      .select('id, application_id, type, title, description, metadata, occurred_at')
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load activities: ${error.message}`)
    const rows = (data ?? []) as {
      id: string; application_id: string; type: string; title: string; description: string | null
      metadata: Record<string, unknown> | null; occurred_at: string
    }[]
    if (rows.length === 0) break

    // Batch-resolve application -> {user_id, job_id} and job -> company_id
    // for this page instead of one query per row.
    const appIds = [...new Set(rows.map((r) => r.application_id))]
    const { data: apps, error: appsError } = await admin.from('applications').select('id, user_id, job_id').in('id', appIds)
    if (appsError) throw new Error(`load applications for activities page: ${appsError.message}`)
    const appById = new Map(((apps ?? []) as { id: string; user_id: string; job_id: string | null }[]).map((a) => [a.id, a]))
    const jobIds = [...new Set([...appById.values()].map((a) => a.job_id).filter((j): j is string => !!j))]
    const { data: jobs, error: jobsError } =
      jobIds.length > 0 ? await admin.from('jobs').select('id, company_id').in('id', jobIds) : { data: [], error: null }
    if (jobsError) throw new Error(`load jobs for activities page: ${jobsError.message}`)
    const companyByJob = new Map(((jobs ?? []) as { id: string; company_id: string | null }[]).map((j) => [j.id, j.company_id]))

    for (const r of rows) {
      if (limit && counts.eligible >= limit) break
      if (!isTimelineEligibleActivity(r)) {
        counts.skipped++
        continue
      }
      const app = appById.get(r.application_id)
      if (!app) {
        counts.skipped++
        continue
      }
      counts.eligible++
      if (apply) {
        const kind: InteractionKind = r.type === 'interview_scheduled' ? 'interview' : 'stage_change'
        await recordInteraction(admin, {
          userId: app.user_id,
          companyId: app.job_id ? companyByJob.get(app.job_id) ?? null : null,
          jobId: app.job_id,
          applicationId: r.application_id,
          kind,
          occurredAt: r.occurred_at,
          title: r.title,
          body: r.description,
          refTable: 'activities',
          refId: r.id,
          metadata: { subject: (r.metadata?.subject as string | undefined) ?? null },
        })
        counts.written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && counts.eligible >= limit)) break
  }
  return counts
}

export async function backfillFollowUps(admin: Admin, apply: boolean, limit: number | null): Promise<Counts> {
  const counts: Counts = { eligible: 0, written: 0, skipped: 0 }
  let cursor: string | null = null
  for (;;) {
    let q = admin
      .from('follow_ups')
      .select(
        'id, contact_id, application_id, note, completed_at, contacts(user_id, company_id), applications(user_id, job_id)'
      )
      .eq('is_completed', true)
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load follow_ups: ${error.message}`)
    const rows = (data ?? []) as unknown as {
      id: string; contact_id: string | null; application_id: string | null; note: string; completed_at: string | null
      contacts: { user_id: string; company_id: string | null } | null
      applications: { user_id: string; job_id: string | null } | null
    }[]
    if (rows.length === 0) break
    for (const r of rows) {
      if (limit && counts.eligible >= limit) break
      const userId = r.contacts?.user_id ?? r.applications?.user_id ?? null
      if (!userId) {
        counts.skipped++
        continue
      }
      counts.eligible++
      if (apply) {
        await recordInteraction(admin, {
          userId,
          companyId: r.contacts?.company_id ?? null,
          contactId: r.contact_id,
          jobId: r.applications?.job_id ?? null,
          applicationId: r.application_id,
          kind: 'follow_up_done',
          occurredAt: r.completed_at ?? new Date().toISOString(),
          title: `Follow-up done — ${r.note}`,
          refTable: 'follow_ups',
          refId: r.id,
          metadata: {},
        })
        counts.written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && counts.eligible >= limit)) break
  }
  return counts
}

export async function backfillReceipts(admin: Admin, apply: boolean, limit: number | null): Promise<Counts> {
  const counts: Counts = { eligible: 0, written: 0, skipped: 0 }
  let cursor: string | null = null
  for (;;) {
    let q = admin
      .from('application_receipts')
      .select('id, application_id, user_id, destination, provenance, verification_state, submitted_at')
      .order('id', { ascending: true })
      .limit(READ_PAGE)
    if (cursor) q = q.gt('id', cursor)
    const { data, error } = await q
    if (error) throw new Error(`load application_receipts: ${error.message}`)
    const rows = (data ?? []) as {
      id: string; application_id: string; user_id: string; destination: string | null
      provenance: string; verification_state: string; submitted_at: string
    }[]
    if (rows.length === 0) break

    const appIds = [...new Set(rows.map((r) => r.application_id))]
    const { data: apps, error: appsError } = await admin.from('applications').select('id, job_id').in('id', appIds)
    if (appsError) throw new Error(`load applications for receipts page: ${appsError.message}`)
    const jobByApp = new Map(((apps ?? []) as { id: string; job_id: string | null }[]).map((a) => [a.id, a.job_id]))
    const jobIds = [...new Set([...jobByApp.values()].filter((j): j is string => !!j))]
    const { data: jobs, error: jobsError } =
      jobIds.length > 0 ? await admin.from('jobs').select('id, company_id').in('id', jobIds) : { data: [], error: null }
    if (jobsError) throw new Error(`load jobs for receipts page: ${jobsError.message}`)
    const companyByJob = new Map(((jobs ?? []) as { id: string; company_id: string | null }[]).map((j) => [j.id, j.company_id]))

    for (const r of rows) {
      if (limit && counts.eligible >= limit) break
      counts.eligible++
      if (apply) {
        const jobId = jobByApp.get(r.application_id) ?? null
        await recordInteraction(admin, {
          userId: r.user_id,
          companyId: jobId ? companyByJob.get(jobId) ?? null : null,
          jobId,
          applicationId: r.application_id,
          kind: 'application_submitted',
          occurredAt: r.submitted_at,
          title: `Application submitted — ${r.destination ?? 'unknown destination'}`,
          refTable: 'application_receipts',
          refId: r.id,
          metadata: { provenance: r.provenance, verification_state: r.verification_state },
        })
        counts.written++
      }
    }
    cursor = rows[rows.length - 1].id
    if (rows.length < READ_PAGE || (limit && counts.eligible >= limit)) break
  }
  return counts
}

function report(label: string, c: Counts, apply: boolean): void {
  console.log(
    `${label.padEnd(20)}: ${c.eligible} eligible${apply ? `, ${c.written} written` : ' (dry run, none written)'}` +
      (c.skipped > 0 ? `, ${c.skipped} skipped (no reproducible signal)` : '')
  )
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs(process.argv.slice(2))
  console.log('backfill-interactions')
  console.log(`  mode : ${apply ? 'APPLY — writes public.interactions' : 'DRY RUN (default) — pass --apply to write'}`)
  if (limit) console.log(`  limit: ${limit} rows per source`)
  console.log('')

  const admin = createAdminClient()
  report('outreach_messages', await backfillOutreach(admin, apply, limit), apply)
  report('activities', await backfillActivities(admin, apply, limit), apply)
  report('follow_ups', await backfillFollowUps(admin, apply, limit), apply)
  report('application_receipts', await backfillReceipts(admin, apply, limit), apply)
}

// Guarded, unlike this directory's other owner-run scripts: this is the one
// script in apps/web/scripts whose per-source functions are also exercised
// directly by a test (scripts/backfill-interactions.test.ts, "backfill
// idempotency on fixtures" — no real DB, a fake admin client passed in).
// Without this guard, importing the module for its exports would run main()
// — which calls createAdminClient() and process.exit(1) on the missing-env
// error every test run gets, killing the test process. tsx invokes this
// file with itself as argv[1], so a real `npx tsx` run still executes main()
// exactly as every sibling script's unconditional call does.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`
if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
