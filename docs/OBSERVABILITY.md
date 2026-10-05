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

## Prompt monitoring (Langfuse): optional, three env vars

Langfuse shows every AI call as a generation: the prompt, the reply, the
model, token counts, cost and latency. It is a second copy. Postgres
`trace_spans` stays the system of record and holds no prompt or reply text.

Setup:

1. Create a Langfuse Cloud account (Hobby is free: 50,000 units a month,
   30 days of retention). Pick the region first, because accounts and data
   are separate per region: EU `https://cloud.langfuse.com` or US
   `https://us.cloud.langfuse.com`.
2. Create a project and copy its public and secret keys.
3. Set all three in the environment (Vercel project settings for production):

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or https://us.cloud.langfuse.com
```

If any one is missing or blank, the whole thing is off: no network call and
none of the `@langfuse/*` packages is loaded. The export uses the current
OpenTelemetry based SDK (`@langfuse/tracing`, `@langfuse/otel`, version 5.11.1),
on its own tracer provider that is never registered globally, so Sentry keeps
the global one.

Optional:

| Variable | Default | Effect |
| --- | --- | --- |
| `LANGFUSE_CAPTURE_CONTENT` | on | The kill switch. Only an unset or blank value or `1`, `true`, `on`, `yes` keeps prompts and replies on. Anything else, a typo included, turns them off. Tokens, cost and timing still go. |
| `LANGFUSE_CAPTURE_DEMO_CONTENT` | off | Demo workspaces send no prompt or reply text unless this is `1`, `true`, `on` or `yes`. A trace whose owner is unknown counts as a demo. |
| `LANGFUSE_SAMPLE_RATE` | `1` | A number from 0 to 1. A value that is not a number means 0, so a typo never raises volume. Chosen per trace by a hash of the trace id, so a trace is sent whole or not at all. The SDK itself never reads this variable, so it is not applied twice. |
| `LANGFUSE_DEMO_SAMPLE_RATE` | `0.25` | The same for demo traces, which use the lower of the two rates. It keeps a burst of demo visitors from eating the free unit budget. |

Limits per trace: at most 400 observations (the root, errors and judge calls
are always kept, and the root records how many were dropped) and 128KB of
captured text.

**What is sent.** One trace per run, named after the surface (copilot,
autopilot, and so on). Each AI call is a generation with model, input and
output tokens, estimated cost, start and end time, error level and message,
and the prompt messages and reply unless capture is off. Graph and agent
steps are plain spans. The user id is sent as is (a random UUID) so Langfuse
can group cost per user. The trace carries `environment` from `VERCEL_ENV`
(production, preview, development) and `release` from `VERCEL_GIT_COMMIT_SHA`,
so preview traffic never mixes into production views. Filter by environment
in the Langfuse UI.

**What is never sent.** Saved API keys and OAuth tokens are not part of any
prompt or span by design, and key-shaped strings are redacted anyway. Prompt
and reply text are never written to Postgres: they live in memory on the span
row and are dropped before the insert.

**Redaction.** Before anything leaves the process, every string passes
through `redactString` from `lib/observability/scrub.ts` (emails, JWTs,
`Bearer` and `Basic` credentials, `sk-`, GitHub, Google and other provider
keys, OAuth tokens, passwords in `key=value` text, URL credentials, private
keys, Cello's AES blobs) and is cut to 16KB. Every pattern is bounded, so a
long unbroken token cannot stall a request. Names, tags and ids are code
constants or UUIDs, and a second pass re-scrubs every string on a span just
before it ends. Structured payloads also redact sensitive key names but keep
numbers, so token counts and cost survive. Redaction is pattern based. Free text such as a
resume still reaches Langfuse with names and phone numbers in it, which is why
the settings page tells users when capture is on and why `LANGFUSE_CAPTURE_CONTENT=0`
exists.

Known gaps, all of them free text a pattern cannot recognise: phone numbers and
street addresses, SSNs, non-ASCII email addresses, passwords written as prose
("my password is hunter2" with no `:` or `=`), 64-hex raw keys, `hf_` and `npm_`
tokens, `Basic <base64>` without an `Authorization` prefix, OAuth `?code=` query
values, and a short secret in a key named `code` or `refresh`. Keys written
into a JSON-escaped message (a tool result is stringified into the prompt) are
caught, including after `\n` and `\t`. The user id and session id are the raw
Cello UUIDs, a stable identifier sent to Langfuse by design.

**Budget.** A unit is a trace, an observation or a score. One copilot run is
a trace plus a graph span, a span per agent step and a generation per AI call.
If the 50,000 a month is not enough, lower `LANGFUSE_SAMPLE_RATE`. Postgres
keeps everything either way, and the Langfuse usage page shows the burn.

**Latency.** When Vercel exposes its request context, the export runs inside
its `waitUntil` and adds about nothing to the response. When it does not (local
development, scripts, or a Vercel function with no context), the export is
awaited for at most 2 seconds, and Vercel logs one line,
`[langfuse] no Vercel request context`, per instance. A slow or unreachable
Langfuse never throws and never costs a request more than that.

**Postgres size.** The step journal (`lib/graph/journal.ts`) caps each stored
step input and output at about 8KB. Long strings are cut with a marker, long
lists keep their length with the overflow items set to null, and small fields
are kept exactly. The run page only needs short fields and list lengths, and
resume reads the LangGraph checkpoint, not these rows.

**OpenRouter.** Each request also sends OpenRouter's `user` field as a hash of
the Cello user id (`cello_` plus 32 hex characters), so the OpenRouter activity
view can tell users apart without a raw id or email.

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
