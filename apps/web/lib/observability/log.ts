// Structured, Sentry-INDEPENDENT error logging.
//
// Every harness step failure already lands in `agent_steps.output.error` —
// that's the audit trail the UI (and RESUMPTION, see executor.ts) reads. But
// a DB row is invisible to whoever is actually debugging a production
// incident: `docker logs`, `vercel logs`, journalctl, whatever the
// self-hoster tails. Before this module, a step failing wrote silently to
// the DB with no corresponding server log line at all — see the "MEASURED
// GAPS" note this was written to close. This module gives every such failure
// one greppable, structured stderr line, and — ONLY IF SENTRY_DSN happens to
// be configured — also forwards it through the scrubbed Sentry pipeline. The
// console line is the primary product here and works with zero Sentry setup;
// Sentry is additive.
//
// PRIVACY: only identifiers and the error's own class/message are logged —
// NEVER a step's input/output (resumes, job descriptions, email bodies,
// answers to ATS forms all live there). The message text is the exact same
// string already written to agent_steps.output.error by the caller (see
// executor.ts's `errMsg`/`errorText` locals) — this makes that string
// visible in two places, it does not expose anything new.

import { captureError } from './sentry'

export interface HarnessErrorContext {
  runId: string
  stepLabel: string
  agentType: string
  /** Where in the executor this failure was observed — e.g. 'plan',
   *  'attempt' (a step exhausted its retries), 'loop', 'fan-out'. Distinct
   *  from `errorClass` below: this is OUR code's phase, that's the JS error's
   *  own type. */
  phase: string
  userId?: string
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor?.name || 'Error'
  return typeof err
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Record a harness step failure. Call this at the same point that already
 * journals `agent_steps.status = 'failed'`, passing the identical error, so
 * the DB row and this log line describe the same event. Intentionally NOT
 * called for expected control-flow stops (budget cap reached, run
 * cancelled/aborted) — see the call sites in executor.ts — only for a
 * genuine failure worth an operator's attention.
 */
export function logHarnessError(ctx: HarnessErrorContext, err: unknown): void {
  const entry = {
    at: new Date().toISOString(),
    scope: 'harness',
    phase: ctx.phase,
    runId: ctx.runId,
    stepLabel: ctx.stepLabel,
    agentType: ctx.agentType,
    errorClass: errorClass(err),
    message: errorMessage(err),
  }
  // Deliberate structured stderr line (not a plain console.error(err)) — see
  // file header for why this exists independently of Sentry.
  console.error(`[harness:error] ${JSON.stringify(entry)}`)

  void captureError(err instanceof Error ? err : new Error(entry.message), {
    tags: { area: 'harness', phase: ctx.phase, agentType: ctx.agentType },
    extra: { runId: ctx.runId, stepLabel: ctx.stepLabel, userId: ctx.userId },
  })
}

/**
 * Same idea as logHarnessError but for an app/api/** route's catch-all
 * handler — one structured stderr line plus a scrubbed, best-effort Sentry
 * report. `extra` should carry IDs/enums only (never a request body, resume
 * text, or email content) — see lib/observability/scrub.ts for the
 * defense-in-depth layer if that's ever violated by accident.
 */
export function logApiError(
  route: string,
  err: unknown,
  extra?: Record<string, unknown>
): void {
  const entry = {
    at: new Date().toISOString(),
    scope: 'api',
    route,
    errorClass: errorClass(err),
    message: errorMessage(err),
  }
  console.error(`[api:error] ${JSON.stringify(entry)}`)

  void captureError(err instanceof Error ? err : new Error(entry.message), {
    tags: { area: 'api', route },
    extra,
  })
}
