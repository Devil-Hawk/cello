// Sentry event scrubbing — the ONE place that decides what is allowed to
// leave this process toward a third-party error-monitoring service.
//
// WHY THIS EXISTS: Cello holds resumes, contact emails, decrypted-in-memory
// API keys (see lib/crypto.ts), OAuth tokens and session cookies. A
// monitoring integration that leaks any of those is strictly worse than
// having no monitoring at all — so scrubbing is not a filter bolted onto an
// event after the fact, it is the mandatory gate every event passes through
// (wired in as Sentry's `beforeSend` / `beforeSendTransaction` /
// `beforeBreadcrumb` hooks — see sentry.ts) before Sentry.init is ever given
// a chance to transmit anything.
//
// This module is deliberately independent of `@sentry/nextjs`'s types: it
// operates on plain JSON-shaped objects, which keeps it trivially unit
// testable (see scrub.test.ts) without needing a live Sentry client, and
// keeps the "what gets redacted" policy readable in one place instead of
// scattered across SDK-specific option objects.
//
// STRATEGY — belt AND suspenders:
//   1. Deny-list KEY NAMES known to hold secrets/PII (password, token,
//      resume, email, ...) — redacted outright regardless of value shape.
//   2. Pattern-redact STRING VALUES that look like a secret/PII even under an
//      innocuous key name (a resume string assigned to `notes`, a stray
//      bearer token embedded in a log line, our own AES-GCM
//      `iv:authTag:data` blob format from lib/crypto.ts, ...).
//   3. Some fields are dropped structurally rather than scrubbed at all
//      (request body, cookies) — see scrubEvent below.

/** Case-insensitive substring match against object keys. Intentionally wide:
 *  under-redacting a secret is the failure that matters here, not
 *  over-redacting a harmless field name. */
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|apikey|authoriz|cookie|session|credential|private[_-]?key|service[_-]?role|encrypted|resume|cv[_-]?text|coverletter|cover[_-]?letter|email|phone|ssn|address|firstname|first[_-]?name|lastname|last[_-]?name|fullname|full[_-]?name|contact)/i

/** Header names dropped outright from event.request.headers. */
const SENSITIVE_HEADER_RE = /(authoriz|cookie|x-supabase|x-api-key|set-cookie)/i

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g
// lib/crypto.ts#encrypt output shape: `${ivBase64}:${authTagBase64}:${encryptedBase64}`.
// Trailing boundary is a negative lookahead (not \b) because base64 padding
// ('=') is a non-word char: a \b right after it only matches if the regex
// backtracks off the padding, which would leave a stray '=' unredacted.
const ENCRYPTED_BLOB_RE =
  /\b[A-Za-z0-9+/]{8,}={0,2}:[A-Za-z0-9+/]{8,}={0,2}:[A-Za-z0-9+/]{4,}={0,2}(?![A-Za-z0-9+/=])/g
const BEARER_RE = /\bBearer\s+\S+/gi
// Common LLM/cloud provider key prefixes (OpenAI/Anthropic/OpenRouter sk-...,
// GitHub tokens, Slack, Google, AWS) — catches a raw key even in a message
// string that no key-name check would ever inspect.
const PROVIDER_KEY_RE = /\b(sk-[a-zA-Z0-9-]{10,}|sk-ant-[a-zA-Z0-9-]{10,}|gh[oprsu]_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})\b/g

const REDACTED = '[redacted]'

/** Pattern-redact secret/PII-shaped substrings inside a string value,
 *  regardless of what key it was stored under. */
export function redactString(value: string): string {
  return value
    .replace(ENCRYPTED_BLOB_RE, '[redacted-secret]')
    .replace(JWT_RE, '[redacted-token]')
    .replace(BEARER_RE, 'Bearer [redacted-token]')
    .replace(PROVIDER_KEY_RE, '[redacted-key]')
    .replace(EMAIL_RE, '[redacted-email]')
}

/** Recursively scrub any JSON-ish value: sensitive key names are fully
 *  redacted, string values are pattern-redacted, everything else (numbers,
 *  booleans, safe strings) passes through unchanged. Depth-bounded so a
 *  pathological/cyclic-looking structure can't hang event processing. */
export function deepScrub(value: unknown, keyHint = '', depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (value == null) return value
  if (SENSITIVE_KEY_RE.test(keyHint)) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, keyHint, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepScrub(v, k, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Minimal structural subset of a Sentry event this module cares about.
 * Intentionally NOT `import type { Event } from '@sentry/nextjs'` — keeping
 * this module decoupled from the SDK's types means it (and its tests) never
 * need the SDK loaded, matching the "zero cost when unconfigured" goal in
 * sentry.ts. sentry.ts casts through this shape at the one call site that
 * wires it into `beforeSend`.
 */
export interface ScrubbableEvent {
  message?: string
  request?: {
    url?: string
    method?: string
    data?: unknown
    cookies?: unknown
    headers?: Record<string, string>
    [key: string]: unknown
  }
  user?: unknown
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  tags?: Record<string, unknown>
  exception?: {
    values?: Array<{ value?: string; [key: string]: unknown }>
    [key: string]: unknown
  }
  breadcrumbs?: ScrubbableBreadcrumb[]
  [key: string]: unknown
}

export interface ScrubbableBreadcrumb {
  message?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

/** `beforeSend` / `beforeSendTransaction`: the mandatory gate for every event
 *  Sentry.init is configured to run before transmission — see sentry.ts. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  // Request body/cookies are NEVER transmitted, full stop — not redacted,
  // dropped, since a resume upload or an ATS-answers payload has no
  // debugging value worth the risk of a scrubbing gap.
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    if (event.request.headers) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (SENSITIVE_HEADER_RE.test(k)) continue
        headers[k] = typeof v === 'string' ? redactString(v) : v
      }
      event.request.headers = headers
    }
    if (event.request.url) event.request.url = redactString(event.request.url)
  }

  // sendDefaultPii is already false in sentry.ts's Sentry.init call, so this
  // should already be empty — cleared again here as defense-in-depth in case
  // that default ever changes upstream or a future call site sets it.
  if (event.user) event.user = undefined

  if (event.extra) event.extra = deepScrub(event.extra, 'extra') as Record<string, unknown>
  if (event.contexts) event.contexts = deepScrub(event.contexts, 'contexts') as Record<string, unknown>
  if (event.tags) {
    const tags: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(event.tags)) {
      tags[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : typeof v === 'string' ? redactString(v) : v
    }
    event.tags = tags
  }

  if (event.message) event.message = redactString(event.message)
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((v) =>
      v.value ? { ...v, value: redactString(v.value) } : v
    )
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)

  return event
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
  if (breadcrumb.data) breadcrumb.data = deepScrub(breadcrumb.data, 'data') as Record<string, unknown>
  if (breadcrumb.message) breadcrumb.message = redactString(breadcrumb.message)
  return breadcrumb
}
