// Types for the Apify BYOK connector (lib/apify/client.ts).
//
// Apify (https://apify.com) runs "actors" (scrapers/automations) on the
// USER'S OWN Apify account, billed to them. This module never bundles a
// token, an actor id, or any credential — see lib/apify/token.ts for how the
// token is read, and the kb_sources.config.actorId field for how the actor is
// chosen (always user-supplied, never hardcoded in code that executes).

/** The subset of Apify run statuses this client cares about. Full list per
 *  https://docs.apify.com/api/v2#/reference/actor-runs — anything else is
 *  treated as still-in-progress and continues to be polled. */
export type ApifyRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ABORTING'
  | 'ABORTED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'

/** One raw item from an actor's default dataset. Shape is actor-specific. */
export type ApifyDatasetItem = Record<string, unknown>

export interface ApifyRunResult {
  runId: string
  actorId: string
  status: ApifyRunStatus
  statusMessage?: string | null
  defaultDatasetId: string | null
  items: ApifyDatasetItem[]
  itemCount: number
}

/**
 * Thrown for any Apify API failure — a bad token, an unknown actor id, a
 * run that ended FAILED/ABORTED/TIMED-OUT, or our own poll budget running
 * out before the run finished. `message` is meant to be shown to the user
 * directly (it surfaces Apify's own error/status text where available).
 */
export class ApifyError extends Error {
  readonly status?: number
  readonly runId?: string

  constructor(message: string, opts: { status?: number; runId?: string } = {}) {
    super(message)
    this.name = 'ApifyError'
    this.status = opts.status
    this.runId = opts.runId
  }
}
