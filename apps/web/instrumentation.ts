// Next.js 14 instrumentation hook — `register()` runs once per server/edge
// runtime instance at boot, before any request is handled. Requires
// `experimental.instrumentationHook: true` in next.config.js on Next 14.1
// (this file is silently never loaded without it — see the comment on that
// flag in next.config.js).
//
// STRICTLY OPTIONAL: initObservability() is a synchronous no-op — it never
// even imports `@sentry/nextjs` — unless SENTRY_DSN is set in the
// environment. See lib/observability/sentry.ts's top-of-file note for
// exactly how that "no import at all" guarantee is implemented. A
// self-hoster who never sets SENTRY_DSN should see this file do nothing
// observable: no log line, no delay, no warning.

export async function register(): Promise<void> {
  const { initObservability } = await import('./lib/observability/sentry')
  await initObservability()
}
