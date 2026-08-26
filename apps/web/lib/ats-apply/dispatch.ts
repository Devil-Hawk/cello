// Dispatches .github/workflows/browser-apply.yml from the app.
//
// WHY A DIRECT fetch() TO THE GITHUB REST API, NOT A NEW DEPENDENCY
//   Nothing in this codebase triggers a GitHub Actions workflow from
//   application code today (searched: no octokit dependency, no existing
//   `workflow_dispatch`/`repository_dispatch` caller). Every existing
//   GH-Actions-facing route runs the OTHER direction — a workflow calling
//   INTO the app (harness-cron.yml -> POST /api/harness/cron with
//   CRON_SECRET). GitHub's REST API for this is one POST with a bearer
//   token and a JSON body — global fetch (already this codebase's idiom for
//   every outbound HTTP call, see app/api/scraper/trigger/route.ts) does
//   the whole job in fewer lines than adding and typing @octokit/rest would
//   cost, so that is the dependency this file does NOT add.
//
// WHY workflow_dispatch, NOT repository_dispatch
//   workflow_dispatch's `inputs` are strongly typed by the workflow file
//   itself (browser-apply.yml declares exactly `draft_id` + `phase`, no
//   more) and show up in the Actions UI keyed to the run that used them —
//   repository_dispatch's free-form `client_payload` buys nothing here and
//   documents the contract nowhere but this file.
//
// NO SECRET EVER TRAVELS IN `inputs` — GitHub prints workflow_dispatch
// inputs in the run's own log and API response in plain text. draft_id is
// an opaque uuid and phase is 'fill'|'submit', both fine to appear there;
// see lib/ats-apply/phase-tokens.ts's header for why the fill/submit
// AUTHORIZATION itself never becomes a value that would need to travel
// through this call at all.

import type { ApplyPhase } from './phase-tokens'

const GH_API = 'https://api.github.com'

/** Matches this repo's git remote (Devil-Hawk/cello). Overridable per
 *  deployment via env, same pattern harness-cron.yml's HARNESS_CRON_URL
 *  var uses for the opposite direction. */
const DEFAULT_OWNER = 'Devil-Hawk'
const DEFAULT_REPO = 'cello'
const WORKFLOW_FILE = 'browser-apply.yml'

export class DispatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchError'
  }
}

export interface DispatchBrowserApplyInput {
  draftId: string
  phase: ApplyPhase
}

/**
 * Fire the browser-runner workflow for one draft/phase. Throws
 * DispatchError on any non-2xx response or missing configuration — a caller
 * that dispatches must know definitively whether the run was actually
 * queued, because app/api/apply/prepare and app/api/apply/confirm have
 * already moved the draft into a phase-in-progress state by the time this
 * is called and cannot silently leave it stuck there.
 */
export async function dispatchBrowserApplyWorkflow(input: DispatchBrowserApplyInput): Promise<void> {
  const token = process.env.GH_ACTIONS_TOKEN
  if (!token) throw new DispatchError('GH_ACTIONS_TOKEN is not configured')

  const owner = process.env.GH_REPO_OWNER || DEFAULT_OWNER
  const repo = process.env.GH_REPO_NAME || DEFAULT_REPO
  const ref = process.env.GH_WORKFLOW_REF || 'main'

  const url = `${GH_API}/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      ref,
      inputs: { draft_id: input.draftId, phase: input.phase },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new DispatchError(`workflow dispatch failed: ${res.status} ${body.slice(0, 300)}`)
  }
}
