# Observability

Cello ships with optional error monitoring and always-on structured logging
for the agent harness. Both exist to answer one question when something
breaks in production: **what failed, where, and why** — without ever leaking
what's IN a user's job search (resumes, contact emails, API keys, application
answers).

## Error monitoring (Sentry) — optional, one env var

Set `SENTRY_DSN` in your environment and error monitoring turns on. That's
the whole setup:

```bash
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
```

**If you never set it, the app runs identically to today.** This isn't a
"disabled by default" flag that still does some work — it's a genuine no-op:

- `lib/observability/sentry.ts` checks `SENTRY_DSN` synchronously, before
  doing anything else. With no DSN, execution returns immediately.
- The `@sentry/nextjs` package itself is never `import`-ed in that case (a
  dynamic `import()` only happens inside the `if (dsn)` branch) — so none of
  its startup side effects run: no console instrumentation, no global
  error/rejection hooks, no "No DSN provided" warning, nothing.
- `next.config.js` does **not** wrap the build with `withSentryConfig` (the
  Sentry Next.js build plugin, mainly used for source-map upload) — that
  plugin talks to Sentry's API during `next build` using an org/project/auth
  token, which would make every self-hoster's build DSN/credential-sensitive
  whether or not they use Sentry. Skipping it means stack traces in the
  Sentry dashboard show minified line numbers instead of pretty source —
  worthwhile trade to keep `next build` fully offline by default. Error
  *capture* itself is unaffected.

Where it's wired in: `instrumentation.ts` (Next's official boot hook — see
`experimental.instrumentationHook` in `next.config.js`, required on Next
14.1) calls `initObservability()` once per server/edge runtime instance.
From there, individual `app/api/**` route catch blocks call `captureError()` /
`logApiError()` at the points that matter — this is **manual, targeted
capture**, not blanket auto-instrumentation of every route. (`logHarnessError()`
is the harness-level counterpart, wired up when the pre-port executor called
it directly; today the harness (`lib/graph/unit.ts`) doesn't call it itself —
its errors propagate up to the route catch block instead.) We control exactly
what's reported.

There is currently no browser/client-side Sentry init — every high-stakes
surface in this app (the agent harness, ATS submission, Gmail sync, key
encryption) is server-side. Client capture can be added later without
touching anything described here.

## Privacy: what gets scrubbed, and how

Every event passes through `lib/observability/scrub.ts`'s `scrubEvent` /
`scrubBreadcrumb`, wired in as Sentry's `beforeSend` / `beforeBreadcrumb`
hooks — **before** the SDK is given a chance to transmit anything:

- **Request bodies and cookies are never transmitted at all** — dropped
  structurally (`event.request.data`, `event.request.cookies`), not
  redacted-and-kept.
- **Sensitive headers are dropped** (`Authorization`, `Cookie`, anything
  matching `x-supabase-*`, `set-cookie`, ...).
- **Sensitive key names are redacted outright**, anywhere in the event, at
  any nesting depth: `password`, `secret`, `token`, `apiKey`, `resume`,
  `cv_text`, `coverLetter`, `email`, `phone`, `address`, `firstName` /
  `lastName`, `serviceRole`, `encrypted`, and more — see
  `SENSITIVE_KEY_RE` in `scrub.ts` for the exact list.
- **Secret/PII-shaped substrings are pattern-redacted inside free text**,
  even under an innocuous key name: email addresses, JWTs, `Bearer <token>`,
  common provider key prefixes (`sk-...`, `sk-ant-...`, `gh*_...`, `AIza...`,
  `AKIA...`), and Cello's own `lib/crypto.ts` AES-GCM blob format
  (`iv:authTag:data`, all base64).
- `sendDefaultPii: false` and `event.user` is cleared unconditionally
  (defense in depth on top of that default).
- Performance tracing is off (`tracesSampleRate: 0`) — one fewer data
  stream to have to reason about scrubbing.

This is proven with a test, not just described: `lib/observability/scrub.test.ts`
builds a fake Sentry event containing a fake Anthropic API key, a fake
encrypted-credential blob, and resume text with a name/email/phone number in
it, runs it through `scrubEvent`, and asserts none of it survives in the
serialized output — while confirming harmless debugging fields (`runId`,
`stepLabel`, `area`) pass through untouched. Run it directly:

```bash
cd apps/web && npx vitest run lib/observability/scrub.test.ts
```

## Structured harness logging — independent of Sentry, always on

Every `agent_steps` row already records `output.error` on failure — that's
the audit trail the UI and resume-from-checkpoint (see `lib/graph/journal.ts`,
`lib/graph/runs.ts`) read.
But a DB row is invisible to whoever is actually debugging an incident by
tailing server logs (`docker logs`, `vercel logs`, `journalctl`, ...), which
historically showed nothing at all for a step failure.

`lib/observability/log.ts#logHarnessError` closes that gap with one
structured, greppable stderr line per genuine step failure — working with
**zero Sentry configuration**:

```
[harness:error] {"at":"2026-07-28T...","scope":"harness","phase":"attempt","runId":"...","stepLabel":"match-job-42","agentType":"matcher","errorClass":"Error","message":"output failed schema: ..."}
```

Only identifiers and the error's own class/message are logged — never a
step's input or output (resumes, job descriptions, ATS answers all live
there). The message is the exact same string already written to
`agent_steps.output.error`, so this adds *visibility*, not a new leak
surface. Expected control-flow stops (the monthly spend cap being hit, a run
being cancelled) are deliberately **not** logged as errors — see the
comment at the `logHarnessError` call site in `lib/graph/unit.ts` for why.

If `SENTRY_DSN` **is** set, the same call also forwards a scrubbed report to
Sentry (tagged `area: harness`, `phase`, `agentType`) — additive, not a
replacement for the structured log line.

`app/api/**` routes get the equivalent via `logApiError(route, error, extra)`
at the small set of catch blocks where it's wired in today (the harness
run/cron routes, Gmail sync, and the ATS submit-approval route) — `extra`
is IDs/enums only, by the same rule.
