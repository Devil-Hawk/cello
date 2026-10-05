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
  /(password|passwd|passphrase|passcode|db[_-]?pass|x-auth|(?:oauth|auth)[_-]?code|secret|token|api[_-]?key|apikey|^(?:pw|pass|pwd|key|auth|jwt|bearer|cred|creds|otp)$|authoriz|cookie|session|credential|private[_-]?key|service[_-]?role|encrypted|resume|cv[_-]?text|coverletter|cover[_-]?letter|email|phone|ssn|address|firstname|first[_-]?name|lastname|last[_-]?name|fullname|full[_-]?name|contact)/i

/** Header names dropped outright from event.request.headers. */
const SENSITIVE_HEADER_RE = /(authoriz|cookie|x-supabase|x-api-key|set-cookie)/i

// LINEAR-TIME CONTRACT. redactString runs on prompts and completions inside a
// request, so every quantifier below is bounded (nothing above 4096) and none
// is nested. An unbounded `[A-Za-z0-9._%+-]+@` or `[A-Za-z0-9+/]{8,}:`
// backtracks quadratically over one long unbroken token (64K chars of 'a'
// took seconds), which blocks the event loop. Callers that handle big text
// (langfuse.ts) also slice BEFORE calling.
// Leading boundary for patterns whose prefix is a common word fragment (sk-,
// 1//, Bearer, Authorization). In JSON text a newline is the two characters
// backslash and n, and n is a letter, so a plain \b or lookbehind on a letter
// would let `\nsk-ant-...` through. Allow a start after a JSON escape too.
// Distinctive prefixes (sk-ant-, ghp_, AKIA, eyJ, ya29., ...) take no boundary
// at all: a glued prefix like `x` or `0` must not hide them.
const LB = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\(?:[nrt]|u[0-9a-fA-F]{4})))`
const lb = (re: RegExp) => new RegExp(LB + re.source, re.flags)

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{5,2048}\b/g
// lib/crypto.ts#encrypt output shape: `${ivBase64}:${authTagBase64}:${encryptedBase64}`.
// Trailing boundary is a negative lookahead (not \b) because base64 padding
// ('=') is a non-word char: a \b right after it only matches if the regex
// backtracks off the padding, which would leave a stray '=' unredacted.
const ENCRYPTED_BLOB_RE = lb(
  /[A-Za-z0-9+/]{8,64}={0,2}:[A-Za-z0-9+/]{8,64}={0,2}:[A-Za-z0-9+/]{4,4096}={0,2}(?![A-Za-z0-9+/=])/g
)
const BEARER_RE = lb(/Bearer\s{1,8}[^\s"',;]{1,2048}/gi)
// Common LLM/cloud provider key prefixes. The `sk-` class includes `_`: the
// Anthropic and OpenAI project key shapes (sk-ant-api03-abc_DEF, sk-proj-...)
// contain underscores, and a class without it stops at the first one and
// leaks the tail. Also Langfuse pk-lf-, Stripe, Supabase, GitHub, Slack,
// Google OAuth client secrets and API keys, and AWS key ids: caught even in a
// message string that no key-name check would ever inspect.
const PROVIDER_KEY_RE =
  /(sk-(?:ant|proj|or|svcacct|admin)-[A-Za-z0-9_-]{10,512}|pk-lf-[A-Za-z0-9_-]{10,512}|sk_(?:live|test)_[A-Za-z0-9]{10,512}|whsec_[A-Za-z0-9]{10,512}|sb_secret_[A-Za-z0-9_-]{10,512}|github_pat_[A-Za-z0-9_]{20,512}|gh[oprsu]_[A-Za-z0-9]{10,512}|GOCSPX-[A-Za-z0-9_-]{10,512}|xox[baprs]-[A-Za-z0-9-]{10,512}|AIza[A-Za-z0-9_-]{20,512}|AKIA[A-Z0-9]{12,512})\b/g
// Any other `sk-` key (OpenAI legacy, Langfuse sk-lf-) needs the boundary,
// or `risk-assessment-framework` would be redacted.
const GENERIC_SK_RE = lb(/sk-[A-Za-z0-9_-]{10,512}\b/g)
// Google OAuth access (ya29.) and refresh (1//) tokens.
const GOOGLE_TOKEN_RE = /ya29\.[A-Za-z0-9._-]{10,512}/g
const GOOGLE_REFRESH_RE = lb(/1\/\/[A-Za-z0-9._-]{10,512}/g)
// `Authorization: Basic <b64>` (Bearer has its own pattern).
const AUTH_HEADER_RE = lb(/Authorization(["']?\s{0,8}[:=]\s{0,8}["']?)(?:Basic|Digest|Token)\s{1,8}[^\s"',;]{1,512}/gi)
// scheme://user:password@host
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi
// `password: x`, `refresh_token="x"`, `api_key=x`: a secret named in prose or
// JSON text, which the key-name check on objects never sees. A quoted value
// may hold spaces; a bare one ends at whitespace or punctuation.
// The lead-in is a lookbehind, not \b: \b never matches between `_` and a
// letter, so DB_PASSWORD or x-api-key would slip through. A bounded prefix
// takes the rest of an env-style or camelCase name (SUPABASE_SERVICE_ROLE_KEY,
// userPassword). `pass` and `pw` are short enough to hit prose (bypass), so
// they only match bare or after a `_`/`-` separator.
const KEY_VALUE_RE =
  /(?<![A-Za-z0-9])([A-Za-z0-9_-]{0,30}(?:password|passwd|passphrase|pwd|secret|secret[_-]?key|service[_-]?role[_-]?key|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key|token|api[_-]?key|cookie)|(?:[A-Za-z0-9]{1,30}[_-])?(?:pass|pw))(\\?["']?\s{0,8}[:=]\s{0,8})(\\"[^"\\\n]{0,512}\\"|"(?:[^"\\\n]|\\.){0,512}"|'[^'\n]{0,512}'|[^\s"',;&]{1,512})/gi
// A bare password value runs to the next whitespace, '&' and ',' included: a
// password may contain them, and stopping early leaks the tail. Quoted values
// are left to KEY_VALUE_RE. Same bounded prefix, one bounded value.
const PASSWORD_BARE_RE =
  /(?<![A-Za-z0-9])([A-Za-z0-9_-]{0,30}(?:password|passwd|pwd)(?:\\?["']?)\s{0,8}[:=]\s{0,8})(?![\\"'])\S{1,200}/gi
// Phone numbers need a separator, paren or plus so a bare digit run (an epoch,
// a count, the all-digit tail of a uuid) is never hit; the leading guard keeps
// a match from starting inside a token, a uuid or a decimal.
const PHONE_RE = /(?<![\w.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g
const SSN_RE = /(?<![\w.-])\d{3}-\d{2}-\d{4}(?![\w-])/g
// 13 to 19 digits with optional space/dash groups; only a Luhn-valid run is a card.
const CARD_RE = /(?<![\w.-])\d(?:[ -]?\d){12,18}(?!\d)/g
const luhn = (digits: string): boolean => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9
    sum += d
  }
  return sum % 10 === 0
}
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g

const REDACTED = '[redacted]'

/** Pattern-redact secret/PII-shaped substrings inside a string value,
 *  regardless of what key it was stored under. */
export function redactString(value: string): string {
  return value
    .replace(ENCRYPTED_BLOB_RE, '[redacted-secret]')
    .replace(PRIVATE_KEY_RE, '[redacted-key]')
    .replace(URL_USERINFO_RE, '$1[redacted]@')
    .replace(JWT_RE, '[redacted-token]')
    .replace(BEARER_RE, 'Bearer [redacted-token]')
    .replace(AUTH_HEADER_RE, 'Authorization$1[redacted-token]')
    .replace(PROVIDER_KEY_RE, '[redacted-key]')
    .replace(GENERIC_SK_RE, '[redacted-key]')
    .replace(GOOGLE_TOKEN_RE, '[redacted-token]')
    .replace(GOOGLE_REFRESH_RE, '[redacted-token]')
    .replace(PASSWORD_BARE_RE, '$1[redacted]')
    .replace(KEY_VALUE_RE, (_m, key: string, sep: string, val: string) => {
      const q = val.startsWith('\\"') ? '\\"' : val[0] === '"' || val[0] === "'" ? val[0] : ''
      return `${key}${sep}${q}${REDACTED}${q}`
    })
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(CARD_RE, (m) => (luhn(m.replace(/\D/g, '')) ? '[redacted-number]' : m))
    .replace(SSN_RE, '[redacted-number]')
    .replace(PHONE_RE, (m) => (/^\d+$/.test(m) ? m : '[redacted-phone]'))
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

/** Like deepScrub, but numbers and booleans always survive. deepScrub's key
 *  deny-list matches `token` and `session`, so it would blank tokensUsed,
 *  promptTokens and costUsd, which are the point of span metadata. A
 *  sensitive key still redacts any string, object or array stored under it. */
export function scrubMetadata(value: unknown, keyHint = '', depth = 0): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth > 8) return '[truncated]'
  if (value == null) return value
  if (SENSITIVE_KEY_RE.test(keyHint)) return REDACTED
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((v) => scrubMetadata(v, keyHint, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubMetadata(v, k, depth + 1)
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
