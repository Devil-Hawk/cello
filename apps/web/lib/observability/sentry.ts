// Optional error monitoring via Sentry.
//
// Cello is open-source and self-hostable. A self-hoster who never sets
// SENTRY_DSN must see ZERO behavioral difference from this module existing:
// no network calls, no console output, no added latency, and — the part
// that's easy to get wrong — no import of `@sentry/nextjs` at all. Every
// exported function here starts with a synchronous `if (!sentryDsn()) return`
// BEFORE the dynamic `import('@sentry/nextjs')`, so the package's own
// side effects (its global console/http hooks, breadcrumb instrumentation,
// the "No DSN provided" logger warning Sentry.init prints when you pass one
// in anyway) never execute — the module is never even loaded into memory.
// That's the mechanism, not just an init flag: `enabled: false` still runs
// Sentry's init pipeline and still logs a warning; never calling `import()`
// runs nothing at all.
//
// PRIVACY: `beforeSend`/`beforeSendTransaction`/`beforeBreadcrumb` wire in
// scrub.ts on the Sentry.init call below — every field of every event this
// SDK would ever transmit passes through that gate first. See scrub.ts's
// top-of-file note and scrub.test.ts for what it strips and why.
//
// SCOPE: server + edge runtimes only (instrumentation.ts calls
// initObservability() for both — see that file). There is no browser/client
// Sentry init here: this app's highest-stakes surfaces (the agent harness,
// ATS submission, Gmail sync, key encryption) are all server-side, and
// adding client-side capture would mean a separate config file, a
// `global-error.tsx`, and a browser bundle change — out of scope for this
// pass. A client Sentry init can be layered on later without touching
// anything below.
//
// Deliberately NO `withSentryConfig` wrapping of next.config.js: that Next
// build-time integration exists mainly to upload source maps (needs an auth
// token / org / project, talks to Sentry's API during `next build`, and would
// make the build itself DSN/credential-sensitive for every self-hoster,
// configured or not). Skipping it means stack traces in the dashboard are
// unminified-JS-line-number-only — an acceptable trade for keeping the build
// itself fully offline-safe. Error CAPTURE (this file) is unaffected; only
// pretty-printed stack traces are.

import { scrubBreadcrumb, scrubEvent, type ScrubbableBreadcrumb, type ScrubbableEvent } from './scrub'

/** Trimmed, structurally-typed surface of the `@sentry/nextjs` module this
 *  file actually calls — avoids a static `import type` of the package so
 *  nothing here forces the SDK's types to be resolved when unused. */
interface SentryModule {
  init(options: Record<string, unknown>): void
  captureException(error: unknown, hint?: Record<string, unknown>): string
  captureMessage(message: string, hint?: Record<string, unknown>): string
}

let sentryModule: SentryModule | null = null
let initStarted = false

/** Trimmed env var, or undefined if unset/blank. The single on/off switch
 *  for this entire module. */
export function sentryDsn(): string | undefined {
  const dsn = process.env.SENTRY_DSN
  return dsn && dsn.trim() ? dsn.trim() : undefined
}

export function isObservabilityEnabled(): boolean {
  return Boolean(sentryDsn())
}

/**
 * Idempotent. Safe to call from instrumentation.ts's register() at boot AND
 * defensively from captureError/captureMessage below (e.g. in a test or any
 * code path that runs before instrumentation.ts's hook has fired) — the
 * second call is a no-op. A no-DSN call is a same-tick synchronous return;
 * it never reaches the `import()`.
 */
export async function initObservability(): Promise<void> {
  const dsn = sentryDsn()
  if (!dsn) return
  if (initStarted) return
  initStarted = true

  const Sentry = (await import('@sentry/nextjs')) as unknown as SentryModule
  sentryModule = Sentry

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    // Errors only. No performance tracing: it's a second data stream this
    // self-hostable app has no need to justify collecting by default, and
    // tracing payloads (route timings, DB call spans) are exactly the kind
    // of thing that's easy to forget also needs scrubbing.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    autoSessionTracking: false,
    beforeSend: (event: unknown) => scrubEvent(event as ScrubbableEvent) as unknown as typeof event,
    beforeSendTransaction: () => null, // belt-and-suspenders alongside tracesSampleRate: 0
    beforeBreadcrumb: (breadcrumb: unknown) =>
      scrubBreadcrumb(breadcrumb as ScrubbableBreadcrumb) as unknown as typeof breadcrumb,
    // Best-effort trim of the ambient instrumentation most likely to capture
    // something sensitive before it ever reaches beforeSend/beforeBreadcrumb —
    // e.g. a `console.log` of a raw Supabase row, or an outgoing HTTP
    // breadcrumb whose URL carries a query-string token. If a given SDK
    // version doesn't ship an integration by one of these names this is a
    // harmless no-op; beforeSend/beforeBreadcrumb above remain the
    // authoritative scrub layer regardless of what this filters.
    integrations: (defaults: Array<{ name: string }>) =>
      defaults.filter((i) => !['Console', 'Http', 'Undici', 'NodeFetch'].includes(i.name)),
  })
}

export interface CaptureContext {
  /** Short, low-cardinality labels for filtering in the Sentry UI — e.g.
   *  { area: 'harness', phase: 'attempt', agentType: 'matcher' }. Never put a
   *  free-text value (an error message, a user string) in a tag. */
  tags?: Record<string, string>
  /** Structured, non-secret debugging context — IDs, counts, enums. Passes
   *  through the same beforeSend scrub as everything else, but treat this as
   *  "should already be safe," not "will be caught if it isn't." */
  extra?: Record<string, unknown>
}

/**
 * Report an exception. Complete no-op with no `@sentry/nextjs` import when
 * SENTRY_DSN is unset. Never throws — a monitoring failure must never break
 * the caller's actual request/step.
 */
export async function captureError(error: unknown, context?: CaptureContext): Promise<void> {
  if (!isObservabilityEnabled()) return
  try {
    await initObservability()
    if (!sentryModule) return
    sentryModule.captureException(error, { tags: context?.tags, extra: context?.extra })
  } catch (captureErr) {
    // The one place allowed to log a raw caught value here: this is the
    // Sentry SDK/transport failing, not user content.
    console.error('[observability] failed to report error to Sentry', captureErr)
  }
}

/** Same contract as captureError, for a non-exception notable event. */
export async function captureMessage(message: string, context?: CaptureContext): Promise<void> {
  if (!isObservabilityEnabled()) return
  try {
    await initObservability()
    if (!sentryModule) return
    sentryModule.captureMessage(message, { tags: context?.tags, extra: context?.extra })
  } catch (captureErr) {
    console.error('[observability] failed to report message to Sentry', captureErr)
  }
}
