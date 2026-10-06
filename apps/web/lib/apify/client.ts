// BYOK Apify client: start an actor run on the USER'S OWN Apify account, wait for
// it to finish, then fetch its dataset items. The HTTP, the retries and the
// long-poll wait belong to apify-client; what stays here is the budget (this app's
// serverless limit) and the plain-language errors.
//
// START THEN WAIT, DELIBERATELY NOT run-sync-get-dataset-items: Apify's run-sync
// endpoint caps at 300s and would happily blow past this app's Vercel function
// limit (maxDuration=60 everywhere in this repo). Waiting on the run lets the
// caller bound its OWN wait (see maxWaitMs) and return a clear timeout error
// instead of the whole request hanging until Vercel kills it mid-response.
//
// Never logs the token and never puts it into an error message.

import { ApifyApiError, ApifyClient } from 'apify-client'
import { ApifyError, type ApifyDatasetItem, type ApifyRunResult, type ApifyRunStatus } from './types'

/**
 * Example actor id pre-filled in the UI. This is NOT executed automatically —
 * the user must explicitly keep or change it before enabling the source (see
 * BUILDER-3 task: "the actor id must be user-configurable — do not hardcode a
 * guessed actor"). It is a commonly used community actor for LinkedIn profile
 * scraping; the user is responsible for verifying its pricing and terms, and
 * can point this at ANY actor id they own or trust.
 */
export const DEFAULT_APIFY_ACTOR_ID = 'apify~linkedin-profile-scraper'

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Apify's own error text for an API failure, our own words for anything else. */
function toApifyError(e: unknown): ApifyError {
  if (e instanceof ApifyError) return e
  if (e instanceof ApifyApiError) {
    const message = e.message || (e.type ? `Apify error: ${e.type}` : `HTTP ${e.statusCode}`)
    return new ApifyError(`Apify API error: ${message}`, { status: e.statusCode })
  }
  return new ApifyError(e instanceof Error ? e.message : 'Apify request failed')
}

/** Rejects when the caller aborts, so a long wait can be raced against it. */
function onAbort(signal?: AbortSignal): { promise: Promise<never>; stop: () => void } {
  let stop = () => {}
  const promise = new Promise<never>((_, reject) => {
    if (!signal) return
    const fail = () => reject(new ApifyError('Apify request was cancelled'))
    if (signal.aborted) return fail()
    signal.addEventListener('abort', fail, { once: true })
    stop = () => signal.removeEventListener('abort', fail)
  })
  return { promise, stop }
}

export interface RunApifyActorOptions {
  /** Actor id or "username/actorName", as configured by the user. */
  actorId: string
  /** The user's own Apify API token (BYOK — never a shared/bundled key). */
  token: string
  /** Actor input, passed through verbatim as the run's JSON body. */
  input?: Record<string, unknown>
  signal?: AbortSignal
  /** Total wall-clock budget to wait for the run to finish. Clamped 5s..55s
   *  (Vercel's maxDuration is 60s repo-wide; 55s leaves headroom to fetch the
   *  dataset and write documents afterwards). */
  maxWaitMs?: number
  /** Kept for callers that still pass it. The wait is a long poll on Apify's
   *  side now, so there is no poll interval to set. */
  pollIntervalMs?: number
  /** Cap on dataset items fetched back in one sync. Clamped 1..1000. */
  itemLimit?: number
}

/**
 * Start an Apify actor run on the user's account, wait for it to reach a
 * terminal state, then fetch its dataset items.
 *
 * Throws ApifyError with Apify's own status/error text on:
 *   - a bad token or unknown actor id (start call fails)
 *   - the run itself ending FAILED / ABORTED / TIMED-OUT
 *   - our own wait budget (maxWaitMs) running out first; in that case the
 *     run keeps going on Apify's side; the message says so and the run id
 *     is attached so the user can check the Apify console.
 */
export async function runApifyActor(opts: RunApifyActorOptions): Promise<ApifyRunResult> {
  const actorId = opts.actorId?.trim()
  if (!actorId) throw new ApifyError('Apify actor id is required')
  if (!opts.token) throw new ApifyError('Apify token is required')

  const maxWaitMs = clamp(opts.maxWaitMs ?? 45_000, 5_000, 55_000)
  const itemLimit = Math.min(1000, Math.max(1, Math.floor(opts.itemLimit ?? 200)))

  const client = new ApifyClient({ token: opts.token, maxRetries: 2 })
  const abort = onAbort(opts.signal)
  const startedAt = Date.now()

  try {
    const started = await Promise.race([client.actor(actorId).start(opts.input ?? {}), abort.promise])
    const runId = started?.id
    if (!runId) {
      throw new ApifyError(
        `Apify did not return a run id for actor "${actorId}". Check that the actor id is correct and the token has access to it.`
      )
    }

    const waitSecs = Math.max(1, Math.ceil((maxWaitMs - (Date.now() - startedAt)) / 1000))
    const run = (await Promise.race([client.run(runId).waitForFinish({ waitSecs }), abort.promise])) ?? started
    const status = run.status as ApifyRunStatus
    const statusMessage = run.statusMessage ?? null

    if (!TERMINAL_STATUSES.has(status)) {
      throw new ApifyError(
        `Apify run ${runId} did not finish within ${Math.round(maxWaitMs / 1000)}s (last status: ${status}). ` +
          `It may still complete on Apify's side. Check the Apify console and re-sync once it finishes.`,
        { runId }
      )
    }
    if (status !== 'SUCCEEDED') {
      throw new ApifyError(`Apify run ${runId} ended with status ${status}${statusMessage ? `: ${statusMessage}` : ''}`, { runId })
    }

    const defaultDatasetId = run.defaultDatasetId ?? started.defaultDatasetId ?? null
    let items: ApifyDatasetItem[] = []
    if (defaultDatasetId) {
      const page = await Promise.race([client.dataset(defaultDatasetId).listItems({ clean: true, limit: itemLimit }), abort.promise])
      items = (page?.items ?? []) as ApifyDatasetItem[]
    }

    return { runId, actorId, status, statusMessage, defaultDatasetId, items, itemCount: items.length }
  } catch (e) {
    throw toApifyError(e)
  } finally {
    abort.stop()
  }
}
