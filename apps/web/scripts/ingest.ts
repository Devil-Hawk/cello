// Scheduled "Find new roles" check: one process, one pass, every user's due
// companies. Run in GitHub Actions with `cd apps/web && npx tsx scripts/ingest.ts`.
//
// Per company: the job board's API when it has one, else the one reader
// (lib/ingest/reader): the site's own search, its sitemaps, its server-rendered
// lists, then the rendered page and a free model, which only this pass can run.
// Per user, after their companies: the requirements pass and one
// ingestion_runs row. The per-company database lock is shared with the in-app
// refresh button and the autopilot, so nothing reads a company twice at once.
//
// Env (the repo secrets the old scrape jobs already used):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   service role
//   OPENROUTER_API_KEY                   platform key; only ':free' models are ever asked
// Optional:
//   COMPANY_ID            check only this company (a UUID), even if it is not due
//   INGEST_USER_ID        check only this user's companies (local testing)
//   INGEST_FORCE=1        treat every selected company as due
//   INGEST_DRY_RUN=1      read and count, write nothing
//   INGEST_PAGE_FETCHER   python | static (default static)
//   INGEST_MODEL_CALLS    model calls per user per pass (default 40)
//   INGEST_DEADLINE_MIN   stop starting companies after this many minutes (default 40)
//
// Logs are public (this repo's Actions), so a line carries ids, counts and
// error class names: never a company name, a URL or an error message.

import { randomUUID } from 'node:crypto'
import { makeSupabaseAtsStore } from '../lib/ats/store'
import { createAdminClient } from '../lib/harness/supabase-admin'
import { loadApiKeys } from '../lib/harness/keys'
import { withTrace } from '../lib/trace/spans'
import { pageFetcherFromEnv } from '../lib/ingest/fetch-page'
import { loadTargets } from '../lib/ingest/reader/targets'
import { trackedOnly } from '../lib/companies/watchlist'
import { DEFAULT_MODEL_CALLS, freeModelKeys, makeIngestModelCall, newModelBudget, type ModelCall } from '../lib/ingest/model'
import { supabaseRequirementsRows } from '../lib/ingest/requirements-pass'
import { hasSource, ingestUser, isDue, makeSupabaseRunsStore, type DueCompany } from '../lib/ingest/run'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 1000

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }))
}

async function main(): Promise<void> {
  const dryRun = process.env.INGEST_DRY_RUN === '1'
  const only = process.env.COMPANY_ID?.trim() || ''
  const onlyUser = process.env.INGEST_USER_ID?.trim() || ''
  if (only && !UUID.test(only)) {
    console.error('ingest: COMPANY_ID must be a UUID')
    process.exit(1)
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim() || undefined
  const calls = Number(process.env.INGEST_MODEL_CALLS) > 0 ? Number(process.env.INGEST_MODEL_CALLS) : DEFAULT_MODEL_CALLS
  const deadlineMin = Number(process.env.INGEST_DEADLINE_MIN) > 0 ? Number(process.env.INGEST_DEADLINE_MIN) : 40
  const startedAt = Date.now()
  const deadlineAt = startedAt + deadlineMin * 60_000

  let admin
  try {
    admin = createAdminClient()
  } catch (error) {
    console.error(`ingest: no database credentials (${errorKind(error)})`)
    process.exit(1)
  }

  const all: DueCompany[] = []
  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      // select * so this works whether or not the metadata column exists yet.
      // Tracked companies only: leads the sourcer or an old email sync wrote are not read.
      const { data, error } = await trackedOnly(admin.from('companies').select('*')).order('created_at', { ascending: true }).range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error('list')
      all.push(...((data ?? []) as unknown as DueCompany[]))
      if (!data || data.length < PAGE_SIZE) break
    }
  } catch (error) {
    console.error(`ingest: could not list companies (${errorKind(error)})`)
    process.exit(1)
  }

  const now = Date.now()
  // A company with neither a careers page nor a stored board has nothing to read.
  const selected = all.filter((c) => (!only || c.id === only) && (!onlyUser || c.user_id === onlyUser) && hasSource(c))
  const due = selected.filter((c) => Boolean(only) || process.env.INGEST_FORCE === '1' || isDue(c, now))
  const byUser = new Map<string, DueCompany[]>()
  for (const c of due) byUser.set(c.user_id, [...(byUser.get(c.user_id) ?? []), c])

  const batchId = randomUUID()
  log('start', { dryRun, companies: all.length, due: due.length, users: byUser.size, models: Boolean(openrouterKey) })

  const fetchPage = pageFetcherFromEnv(process.env.INGEST_PAGE_FETCHER)
  const runs = makeSupabaseRunsStore(admin, dryRun)

  for (const [userId, companies] of byUser) {
    const budget = newModelBudget(calls)
    const targets = await loadTargets(admin, userId)
    // The demo guards run on every account: an expired demo gets no model at all.
    // The platform key is what pays for the (free) model; the account is the user's.
    let model: ModelCall | null = null
    if (openrouterKey) {
      try {
        model = makeIngestModelCall(freeModelKeys(await loadApiKeys(admin, userId), openrouterKey), { budget })
      } catch {
        model = null
      }
    }
    try {
      const summary = await withTrace(admin, userId, { name: 'find-new-roles', metadata: { batch: batchId } }, () =>
        ingestUser(
          userId,
          companies,
          {
            store: makeSupabaseAtsStore(admin, { lockClient: admin, holder: `ingest-${batchId}`, dryRun }),
            runs,
            requirements: supabaseRequirementsRows(admin, userId, dryRun),
            budget,
            deadlineAt,
            fetchPage,
            model,
            mode: 'scheduled',
            targets,
          },
          { batchId, trigger: 'schedule' }
        )
      )
      const p = summary.patch
      log('user', {
        userId,
        status: p.status,
        partial: p.partial_reason,
        checked: p.companies_checked,
        failed: p.companies_failed,
        total: companies.length,
        found: p.jobs_found,
        new: p.jobs_new,
        updated: p.jobs_updated,
        closed: p.jobs_closed,
        failures: p.failures_by_provider,
        modelCalls: p.model_calls,
        modelFailures: budget.failed,
        ms: p.duration_ms,
      })
    } catch (error) {
      log('user_error', { userId, error: errorKind(error) })
    }
  }

  log('done', { durationMs: Date.now() - startedAt, users: byUser.size })
  // Handles left open by the page fetcher or the trace exporter must not hold the job.
  process.exit(0)
}

main().catch((error) => {
  console.error(`ingest: fatal (${errorKind(error)})`)
  process.exit(1)
})
