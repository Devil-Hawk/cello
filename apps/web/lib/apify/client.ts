// BYOK Apify client: start an actor run on the USER'S OWN Apify account and
// poll it to completion, then fetch its dataset items.
//
// ASYNC RUN + POLL, DELIBERATELY NOT run-sync-get-dataset-items: Apify's
// run-sync endpoint caps at 300s and would happily blow past this app's
// Vercel serverless function limit (maxDuration=60 everywhere in this repo).
// Polling lets the caller bound its OWN wait (see maxWaitMs) and return a
// clear timeout error instead of the whole request hanging until Vercel kills
// it mid-response.
//
// Framework-free (global fetch only) so this runs in a route handler or any
// future cron context identically. Never logs the token; never throws it
// into an error message.

import { ApifyError, type ApifyDatasetItem, type ApifyRunResult, type ApifyRunStatus } from './types'

const APIFY_API = 'https://api.apify.com/v2'
const USER_AGENT = 'cello-job-tracker/1.0 (+https://cello-two.vercel.app)'

/** Per-HTTP-request timeout (start call, each poll, dataset fetch). */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Example actor id pre-filled in the UI. This is NOT executed automatically —
 * the user must explicitly keep or change it before enabling the source (see
 * BUILDER-3 task: "the actor id must be user-configurable — do not hardcode a
 * guessed actor"). It is a commonly used community actor for LinkedIn profile
 * scraping; the user is responsible for verifying its pricing and terms, and
 * can point this at ANY actor id they own or trust.
 */
export const DEFAULT_APIFY_ACTOR_ID = 'apify~linkedin-profile-scraper'

const TERMINAL_STATUSES: ReadonlySet<ApifyRunStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
  'TIMED-OUT',
])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Apify accepts an actor identified as "username/actorName" or
 * "username~actorName" in the REST path — the tilde form is the one that is
 * URL-path-safe, so normalize slashes to tildes before building the URL.
 */
function actorPath(actorId: string): string {
  return encodeURI(actorId.trim().replace(/\//g, '~'))
}

interface ApifyFetchOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

/** Low-level authenticated fetch against the Apify REST API. Never throws the
 *  token; surfaces Apify's own error text on a non-2xx response. */
async function apifyFetch(url: string, token: string, opts: ApifyFetchOptions = {}): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onExternalAbort)

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // Never follow redirects — the fixed api.apify.com host plus this is
      // defense in depth even though the URL is not user-supplied.
      redirect: 'error',
      signal: controller.signal,
    })

    const raw = await res.text()
    let parsed: unknown = null
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }

    if (!res.ok) {
      const errObj = parsed as { error?: { message?: string; type?: string } } | null
      const message =
        errObj?.error?.message ||
        (errObj?.error?.type ? `Apify error: ${errObj.error.type}` : null) ||
        raw.slice(0, 300) ||
        `HTTP ${res.status}`
      throw new ApifyError(`Apify API error: ${message}`, { status: res.status })
    }

    return parsed
  } catch (e) {
    if (e instanceof ApifyError) throw e
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ApifyError('Apify request timed out')
    }
    throw new ApifyError(e instanceof Error ? e.message : 'Apify request failed')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onExternalAbort)
  }
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
  /** Delay between poll requests. Clamped 1s..10s. */
  pollIntervalMs?: number
  /** Cap on dataset items fetched back in one sync. Clamped 1..1000. */
  itemLimit?: number
}

/**
 * Start an Apify actor run on the user's account, poll it to a terminal
 * state, then fetch its dataset items.
 *
 * Throws ApifyError with Apify's own status/error text on:
 *   - a bad token or unknown actor id (start call fails)
 *   - the run itself ending FAILED / ABORTED / TIMED-OUT
 *   - our own poll budget (maxWaitMs) running out first — in that case the
 *     run keeps going on Apify's side; the message says so and the run id
 *     is attached so the user can check the Apify console.
 */
export async function runApifyActor(opts: RunApifyActorOptions): Promise<ApifyRunResult> {
  const actorId = opts.actorId?.trim()
  if (!actorId) throw new ApifyError('Apify actor id is required')
  if (!opts.token) throw new ApifyError('Apify token is required')

  const maxWaitMs = clamp(opts.maxWaitMs ?? 45_000, 5_000, 55_000)
  const pollIntervalMs = clamp(opts.pollIntervalMs ?? 2_000, 1_000, 10_000)
  const itemLimit = Math.min(1000, Math.max(1, Math.floor(opts.itemLimit ?? 200)))

  const path = actorPath(actorId)
  const startedAt = Date.now()

  const startRes = (await apifyFetch(`${APIFY_API}/acts/${path}/runs`, opts.token, {
    method: 'POST',
    body: opts.input ?? {},
    signal: opts.signal,
  })) as { data?: { id?: string; status?: ApifyRunStatus; defaultDatasetId?: string } } | null

  const runId = startRes?.data?.id
  if (!runId) {
    throw new ApifyError(
      `Apify did not return a run id for actor "${actorId}" — check that the actor id is correct and the token has access to it.`
    )
  }

  let status: ApifyRunStatus = startRes?.data?.status ?? 'READY'
  let defaultDatasetId: string | null = startRes?.data?.defaultDatasetId ?? null
  let statusMessage: string | null = null

  while (!TERMINAL_STATUSES.has(status)) {
    if (Date.now() - startedAt >= maxWaitMs) {
      throw new ApifyError(
        `Apify run ${runId} did not finish within ${Math.round(maxWaitMs / 1000)}s (last status: ${status}). ` +
          `It may still complete on Apify's side — check the Apify console and re-sync once it finishes.`,
        { runId }
      )
    }
    await sleep(pollIntervalMs)

    const poll = (await apifyFetch(`${APIFY_API}/actor-runs/${runId}`, opts.token, {
      signal: opts.signal,
    })) as { data?: { status?: ApifyRunStatus; defaultDatasetId?: string; statusMessage?: string | null } } | null

    status = poll?.data?.status ?? status
    defaultDatasetId = poll?.data?.defaultDatasetId ?? defaultDatasetId
    statusMessage = poll?.data?.statusMessage ?? null
  }

  if (status !== 'SUCCEEDED') {
    throw new ApifyError(
      `Apify run ${runId} ended with status ${status}${statusMessage ? `: ${statusMessage}` : ''}`,
      { runId }
    )
  }

  let items: ApifyDatasetItem[] = []
  if (defaultDatasetId) {
    const data = await apifyFetch(
      `${APIFY_API}/datasets/${defaultDatasetId}/items?clean=true&limit=${itemLimit}`,
      opts.token,
      { signal: opts.signal, timeoutMs: 20_000 }
    )
    if (Array.isArray(data)) items = data as ApifyDatasetItem[]
  }

  return {
    runId,
    actorId,
    status,
    statusMessage,
    defaultDatasetId,
    items,
    itemCount: items.length,
  }
}
