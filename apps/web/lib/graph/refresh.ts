// The jobs/refresh entrypoint — LangGraph Functional API port of POST
// /api/jobs/refresh's per-company loop (docs/superpowers/specs/2026-08-16-
// langgraph-port-design.md, Stage 1B "jobs/refresh becomes a thread
// handoff"). Read app/api/jobs/refresh/route.ts (the frozen response
// contract) and lib/graph/runs.ts (the wave/deadline-interrupt pattern this
// file follows, at a much smaller scale) before touching this file.
//
// WHY A TASK PER COMPANY
//   refreshCompany() (lib/ats/index.ts) never throws — failures land in its
//   own result.errors — so it is already exactly as total as
//   lib/graph/journal.ts's upserts need a task to be for safe replay. Naming
//   each task `refreshCompany:${companyId}` (not one shared task reused
//   COMPANY_CONCURRENCY times, and not an index-based name) gives every
//   company a checkpoint identity that is stable regardless of which worker
//   claims it or in what order concurrent workers race to claim indices —
//   unlike lib/graph/runs.ts's `unit:${label}` scheme, which additionally
//   depends on call ORDER staying deterministic across replays (see that
//   file's header), a companyId-keyed name does not need that: two replays
//   dispatching the same set of companyIds in a different relative order
//   still resolve every prior company from its own unique-named checkpoint.
//   On a resumed invocation, every already-completed company's task
//   resolves near-instantly from the checkpoint (memoized, not re-fetched)
//   while the remaining ones actually run — there is no separate "resume
//   from cursor N" branch; replaying the whole company list IS the resume.
//
// RULING 9 — the DB client rides config.configurable, never task input or
// output. A supabase-js client holds live sockets and closures; LangGraph's
// Functional API requires task inputs/outputs to be checkpoint-serializable
// (see @langchain/langgraph's own task() doc: "When a checkpointer is
// enabled, the function inputs and outputs must be serializable"). Putting
// the client on a task's args would try to persist it into
// langgraph.checkpoints; config.configurable never lands there — it is
// supplied FRESH on every invokeGraphForUser call (see lib/graph/invoke.ts's
// header and its `extraConfigurable` doc), never part of a graph's
// persisted state. So refreshCompanyTask below never receives the client as
// an argument: it reads it back out of the AMBIENT config via
// `getConfig()`, the mechanism @langchain/langgraph exports specifically so
// nested task calls can see values threaded onto the invoking config
// without those values passing through a checkpointed argument. The route
// supplies it per request as `extraConfigurable: { dbClient }` — see
// app/api/jobs/refresh/route.ts.
//
// CONTIGUOUS-PREFIX PROCESSING, SAME CONCURRENCY, SOFT DEADLINE — ported
// from the deleted app/api/jobs/refresh/bounded-run.ts, not imported from
// it (that file is gone in this same commit; its guarantees now live here
// as this file's own logic, pinned by refresh.test.ts instead of a
// standalone bounded-run.test.ts). Workers claim `companyIds` indices
// monotonically and check the deadline only before claiming a NEW index, so
// the completed set is always a prefix, at least one company is always
// attempted even if the deadline has already passed by the time this
// executes, and the concurrency width never exceeds COMPANY_CONCURRENCY —
// see runRefreshWave below for the full argument (identical to
// bounded-run.ts's own, which refresh.test.ts's "processes a prefix..."
// suite re-proves against this file's copy).

import { entrypoint, task, interrupt, getConfig } from '@langchain/langgraph'
import type { BaseCheckpointSaver, LangGraphRunnableConfig } from '@langchain/langgraph'
import type { createClient } from '../supabase/server'
import { refreshCompany, type AtsStore, type CompanyInput, type CompanyRefreshResult, type JobUpsertRow } from '../ats'

/** Same soft wall-clock ceiling as the pre-port route's own TIME_BUDGET_MS —
 *  see the (now-deleted) app/api/jobs/refresh/route.ts header for the
 *  measurement behind 25s: a Vercel maxDuration=60s response lands at
 *  ~35-56s with this budget, versus a 504 with no budget at all. */
const TIME_BUDGET_MS = 25_000

/** Same per-company fan-out width the pre-port route used. */
const COMPANY_CONCURRENCY = 5

const PAGE_SIZE = 1000

/** The request-scoped, RLS-enforced client a route builds per invocation —
 *  same type route.ts itself used to declare locally as `ServerSupabase`.
 *  Deliberately NOT the untyped harness AdminClient: jobs/companies ARE in
 *  @cello/shared's generated Database type, unlike the harness tables
 *  AdminClient exists for (see lib/harness/types.ts's own note on that). */
export type RefreshDbClient = Awaited<ReturnType<typeof createClient>>

/** Thrown when config.configurable.dbClient is absent — mirrors
 *  lib/graph/unit.ts's MissingUserIdError: a caller that forgot to pass
 *  `extraConfigurable: { dbClient }` to invokeGraphForUser gets a clearly-
 *  attributed refusal instead of every company silently failing to refresh
 *  through an undefined store. */
export class MissingDbClientError extends Error {
  constructor() {
    super(
      'refreshJobs: config.configurable.dbClient is required — pass ' +
        '{ extraConfigurable: { dbClient: <the request\'s RLS-scoped client> } } to ' +
        'invokeGraphForUser (spec binding ruling 9). See app/api/jobs/refresh/route.ts.'
    )
    this.name = 'MissingDbClientError'
  }
}

// --- store (ported verbatim from the pre-port route's own makeStore) -------

function makeStore(client: RefreshDbClient): AtsStore {
  return {
    async listJobExternalIds(companyId: string): Promise<Set<string>> {
      const ids = new Set<string>()
      // Pagination within a company is always sequential.
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await client
          .from('jobs')
          .select('external_id')
          .eq('company_id', companyId)
          .range(from, from + PAGE_SIZE - 1)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          if (row.external_id) ids.add(row.external_id)
        }
        if (!data || data.length < PAGE_SIZE) break
      }
      return ids
    },

    async upsertJobs(rows: JobUpsertRow[]): Promise<void> {
      const { error } = await client
        .from('jobs')
        .upsert(rows, { onConflict: 'company_id,external_id', ignoreDuplicates: false })
      if (error) throw new Error(error.message)
    },

    async backfillJobDescriptions(
      rows: { company_id: string; external_id: string; description: string }[]
    ): Promise<number> {
      // One statement per row, but only for rows whose description is still
      // empty — the `.or()` guard makes this a no-op for anything already
      // populated, so a refresh can never clobber a stored description.
      let changed = 0
      for (const row of rows) {
        const { data, error } = await client
          .from('jobs')
          .update({ description: row.description })
          .eq('company_id', row.company_id)
          .eq('external_id', row.external_id)
          .or('description.is.null,description.eq.')
          .select('id')
        if (error) throw new Error(error.message)
        changed += (data as unknown[] | null)?.length ?? 0
      }
      return changed
    },

    async saveCompanyMetadata(companyId: string, metadata: Record<string, unknown>): Promise<void> {
      const { error } = await client
        .from('companies')
        .update({ metadata: metadata as never })
        .eq('id', companyId)
      // Throw so refreshCompany's tolerant catch handles a missing column
      // (42703 / PGRST204) the same as any other metadata write failure.
      if (error) throw new Error(error.message)
    },

    async updateCompanyLastScraped(companyId: string): Promise<void> {
      const { error } = await client
        .from('companies')
        .update({ last_scraped_at: new Date().toISOString() })
        .eq('id', companyId)
      if (error) throw new Error(error.message)
    },
  }
}

// --- input / output shapes --------------------------------------------------

/** Everything refreshCompany needs about a company besides its id — the
 *  route already reads all of this off the companies row today. */
export interface RefreshCompanyOptions {
  name: string
  domain: string | null
  career_url: string | null
  metadata?: unknown
}

export interface RefreshJobsInput {
  /** Ordered — dispatch order, and what `processed` counts a PREFIX of. */
  companyIds: string[]
  perCompanyOptions: Record<string, RefreshCompanyOptions>
}

export interface RefreshJobsTotals {
  found: number
  inserted: number
  companiesWithAts: number
}

export interface RefreshJobsOutcome {
  results: CompanyRefreshResult[]
  totals: RefreshJobsTotals
  total: number
  processed: number
}

/** The exact payload `interrupt()` carries on a deadline pause — the only
 *  shape a paused invocation's `result.__interrupt__[0].value` can take. */
export interface RefreshDeadlineInterrupt {
  kind: 'deadline'
  processed: number
  total: number
}

/**
 * Extracts the deadline-interrupt payload from whatever
 * invokeGraphForUser's `result` looks like, or returns null when the graph
 * actually finished (a plain RefreshJobsOutcome). Mirrors
 * lib/graph/runs.ts#markRunPausedOnInterrupt's own shape-check — jobs/
 * refresh has no domain "run" row to journal a paused status onto (unlike
 * harnessRun's agent_runs), so this returns the payload itself rather than
 * writing anywhere.
 */
export function getRefreshDeadlineInterrupt(result: unknown): RefreshDeadlineInterrupt | null {
  const interrupts = (result as { __interrupt__?: { value?: unknown }[] } | null)?.__interrupt__
  if (!Array.isArray(interrupts) || interrupts.length === 0) return null
  const value = interrupts[0]?.value
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'deadline' &&
    typeof (value as { processed?: unknown }).processed === 'number' &&
    typeof (value as { total?: unknown }).total === 'number'
  ) {
    return value as RefreshDeadlineInterrupt
  }
  return null
}

// --- per-company task --------------------------------------------------------

function makeRefreshCompanyTask(companyId: string) {
  return task({ name: `refreshCompany:${companyId}` }, async (input: CompanyInput): Promise<CompanyRefreshResult> => {
    // See RULING 9 above: the client is read back from the ambient config,
    // never from `input` (input IS checkpointed; a live client cannot be).
    const config = getConfig()
    const dbClient = config.configurable?.dbClient as RefreshDbClient | undefined
    if (!dbClient) throw new MissingDbClientError()
    return refreshCompany(makeStore(dbClient), input)
  })
}

// --- bounded-concurrency, deadline-respecting dispatch ----------------------
//
// Ported from the deleted bounded-run.ts (see this file's header) — the same
// worker-pool shape, over per-company task CALLS instead of a raw async fn.
// `fn` is required to be total (never reject) for the prefix property to
// hold; makeRefreshCompanyTask's own refreshCompany call already is, exactly
// like bounded-run.ts's own contract required of its caller.
async function runRefreshWave(
  companyIds: readonly string[],
  perCompanyOptions: Record<string, RefreshCompanyOptions>,
  deadline: number,
  now: () => number = Date.now
): Promise<{ results: CompanyRefreshResult[]; processed: number }> {
  const settled: CompanyRefreshResult[] = new Array(companyIds.length)
  const completed: boolean[] = new Array(companyIds.length).fill(false)

  let next = 0
  let started = 0

  const width = Math.max(1, Math.min(COMPANY_CONCURRENCY, companyIds.length))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      // Checked before claiming an index, so an index is never claimed and
      // then abandoned — that is what keeps the completed set a PREFIX.
      if (started > 0 && now() >= deadline) return
      const index = next++
      if (index >= companyIds.length) return
      started++
      const companyId = companyIds[index]
      const options = perCompanyOptions[companyId]
      if (!options) {
        throw new Error(`refreshJobs: perCompanyOptions is missing an entry for companyId "${companyId}"`)
      }
      const companyInput: CompanyInput = {
        id: companyId,
        name: options.name,
        domain: options.domain,
        career_url: options.career_url,
        metadata: options.metadata,
      }
      settled[index] = await makeRefreshCompanyTask(companyId)(companyInput)
      completed[index] = true
    }
  })

  await Promise.all(workers)

  const results = settled.filter((_, i) => completed[i])
  return { results, processed: results.length }
}

// --- the entrypoint -----------------------------------------------------------

export const refreshJobsGraph = entrypoint(
  {
    name: 'refreshJobs',
    // `true` defers the checkpointer to a per-call override — see
    // lib/graph/runs.ts's identical field for the verified-safe cast this
    // mirrors (EntrypointOptions.checkpointer is typed narrower than what
    // the runtime actually accepts).
    checkpointer: true as unknown as BaseCheckpointSaver,
  },
  async (input: RefreshJobsInput, config: LangGraphRunnableConfig): Promise<RefreshJobsOutcome> => {
    // Fail fast, once, with a clear error — rather than every one of
    // `companyIds.length` per-company tasks throwing the same
    // MissingDbClientError independently. Each task still re-reads the
    // client itself (RULING 9) — this is a cheap up-front check, not a
    // substitute for that.
    if (!config.configurable?.dbClient) {
      throw new MissingDbClientError()
    }

    const { companyIds, perCompanyOptions } = input

    // Fresh every execution attempt, never persisted — identical reasoning
    // to lib/graph/runs.ts's own `deadline` (see that file's header RESUME
    // section): a resumed invocation gets a full, real budget again, and
    // every already-completed company resolves near-instantly from the
    // checkpoint regardless of how much of that budget it "uses".
    const deadline = Date.now() + TIME_BUDGET_MS

    const { results, processed } = await runRefreshWave(companyIds, perCompanyOptions, deadline)

    if (processed < companyIds.length) {
      interrupt({ kind: 'deadline', processed, total: companyIds.length } satisfies RefreshDeadlineInterrupt)
      // interrupt() always throws here (no resume value is ever delivered
      // to a deadline pause — nothing waits on a human answer). This line
      // only exists so a future reader does not mistake the block above for
      // dead code that needs a `return`.
    }

    const totals: RefreshJobsTotals = {
      found: results.reduce((sum, r) => sum + r.found, 0),
      inserted: results.reduce((sum, r) => sum + r.inserted, 0),
      companiesWithAts: results.filter((r) => r.provider !== null).length,
    }

    return { results, totals, total: companyIds.length, processed }
  }
)
