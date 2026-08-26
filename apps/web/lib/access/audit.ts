// The demo access-code audit trail — "we should be able to see what someone
// did with a particular access code".
//
// WHAT MAY BE WRITTEN HERE, AND WHAT MAY NEVER BE
//   Every row in access_code_events is read later by the OWNER of the code, and
//   the person who generated it is a guest who was handed a link, not someone
//   who signed a privacy policy. So this table records the SHAPE of a session,
//   never its content:
//
//     ALLOWED   an action name from the app's own vocabulary
//               ('jobs.score_batch'), a route, counts, ids, enums, and a
//               coarse client hint.
//     NEVER     the plaintext access code, an auth token or session cookie, a
//               full IP address, an email address or email body, résumé text,
//               a job description, an LLM prompt or completion — any prose at
//               all.
//
//   Those rules are enforced structurally rather than trusted to call sites,
//   because a call site that leaks a résumé into `detail` is a bug nobody will
//   notice until the data is already in the table. Five layers, in the order
//   they run — and the order is part of the policy, not an implementation
//   detail (see lib/access/scrub.ts):
//
//     0. BOUNDS    — every field is CUT TO SIZE BEFORE it is scanned, and the
//                    key count, value length and serialized size are capped
//                    after. Bounding first is what stops a 50MB `detail` string
//                    from costing a CPU-second on its way to being discarded.
//     1. KEY DENY  — sensitive-looking keys are dropped (lib/observability's
//                    deepScrub list, plus the ones that matter here: code,
//                    hash, ip, body, text, prompt, ...).
//     2. PATTERN   — emails, JWTs, bearer tokens, provider keys and our own
//                    encrypted-blob shape are redacted inside every string
//                    (shared with the Sentry scrubber, so there is ONE such
//                    policy in this codebase, not two that drift), then IP
//                    addresses.
//     3. CODE      — every substring that would be REDEEMED as an access code
//                    becomes '[redacted-code]', derived from the normalizer in
//                    codes.ts rather than restated, so no spelling that still
//                    works can slip past. The one secret this feature owns must
//                    never be recoverable from its own audit trail.
//     4. SHAPE     — a surviving `detail` string must match an ALLOW-LIST of
//                    id/enum/slug/timestamp shapes. No whitespace (prose), no
//                    '@' (email), no '/' (path or URL), no run of more than
//                    four digits and no more than six digits in all (phone,
//                    SSN, card, ZIP, date of birth — spelled with separators or
//                    without, and with or without a letter in front of them),
//                    no unbroken sixteen-character alphanumeric run and no more
//                    than twenty alphanumerics in total (API keys, session ids,
//                    base64 blobs — including ones split up with dashes or
//                    dots), nothing carrying a redaction marker. Exactly two
//                    long shapes are exempt, by exact pattern: a canonical uuid
//                    and an ISO timestamp WITH a time of day (a bare date is a
//                    date of birth as far as this table can tell, so it is not
//                    exempt). This is the layer that holds when the pattern
//                    list has not yet learned about some new secret format.
//
//   WHAT THIS DOES NOT GUARANTEE, so nobody reads the list above as more than
//   it is: layer 4 cannot tell a short word from an id, so a call site that
//   passes `{ candidate: 'ankit' }` records 'ankit'. Nothing here inspects
//   MEANING. What is guaranteed is that no whitespace, no recognised secret
//   format, no address, no redeemable code and no unbounded blob reaches the
//   table — and that call sites are expected to pass counts, ids and enums.
//
// WHY THE SERVICE KEY
//   access_code_events deliberately has NO insert policy (see the migration).
//   Writes therefore MUST go through the service-role client — which means a
//   demo session can neither forge events nor suppress its own trail, because
//   it has no path to the table at all. Pass createAdminClient(); never a
//   cookie-scoped client, which would silently write nothing.
//
//   The read side matches, and has to: lib/access/session.ts decides WHOSE
//   trail an event belongs to with the service-role client as well. A write the
//   subject cannot reach is worth nothing if the subject can answer "am I being
//   audited" with a no.
//
// AUDITING NEVER BREAKS THE THING IT AUDITS
//   recordAccessEvent resolves rather than throws, always, AND it resolves
//   within AUDIT_DEADLINE_MS whether or not the database ever answers. Both
//   halves are needed, and only the first one used to be true: every caller
//   AWAITS this write (Next 14 has no after()/waitUntil, so a floating promise
//   is an event lost when the process is torn down after the response), so an
//   insert that merely HANGS spent the handler's whole maxDuration budget and
//   turned a 200 into a gateway timeout. A failed — or unanswered — audit write
//   is logged to stderr and swallowed: taking down the feature being audited in
//   order to record that it ran is a strictly worse outcome than a gap in the
//   trail.
//
//   What that buys a caller is precise, and no more than this: the trail may
//   cost their request up to AUDIT_DEADLINE_MS of latency, and can never cost
//   it its result. It is NOT free — see withAuditDeadline — and no comment in
//   this codebase may say it is.
//
// Server-only: this module reads the service key's environment and must never
// be imported from a client component.

import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deepScrub } from '@/lib/observability/scrub'
import {
  boundForScrub,
  isRecordableToken,
  redactCodesAndIps,
  scrubAuditText,
} from './scrub'

// The text gate lives in ./scrub.ts; re-exported here because this module is
// the feature's front door and every existing caller (and test) knows this
// name.
export { redactAccessCodes } from './scrub'

const EVENTS_TABLE = 'access_code_events'

/** The kinds the migration documents for access_code_events.kind. */
export const ACCESS_EVENT_KINDS = ['redeemed', 'page_view', 'action', 'denied'] as const
export type AccessEventKind = (typeof ACCESS_EVENT_KINDS)[number]

/**
 * The app's own vocabulary. This is a suggestion list, not a closed set: it
 * exists so editors autocomplete the established spelling and a new feature
 * that needs a new verb is not blocked on editing this file. Anything passed is
 * normalized to the same `area.verb` shape below.
 */
export const ACCESS_EVENT_ACTIONS = [
  'page.view',
  'jobs.score_batch',
  'jobs.search',
  'resume.tailor',
  'resume.upload',
  'outreach.draft',
  'outreach.send',
  'copilot.run',
  'code.redeem',
  'code.denied',
] as const
export type KnownAccessEventAction = (typeof ACCESS_EVENT_ACTIONS)[number]
/** `string & {}` keeps autocomplete for the known verbs without closing the set. */
export type AccessEventAction = KnownAccessEventAction | (string & {})

// --- bounds ------------------------------------------------------------------

/** Long enough for 'outreach.draft_followup', short enough to stay a label. */
const ACTION_MAX_CHARS = 64
/** A route with a uuid in it fits comfortably; a pasted document does not. */
const TARGET_MAX_CHARS = 200
const DETAIL_MAX_KEYS = 12
const DETAIL_MAX_KEY_CHARS = 40
/** A uuid is 36. Anything longer than this is not an id, it is content. */
const DETAIL_MAX_VALUE_CHARS = 64
/** Backstop on the serialized jsonb, after every per-field bound. */
const DETAIL_MAX_BYTES = 1024
/** Stop walking a pathological object; the key cap already bounds what we keep. */
const DETAIL_MAX_ENTRIES_SCANNED = 200
/** 48 bits of hint. Enough to tell two demo visitors apart, far too little to
 *  be an identifier — and it is an HMAC, so it is not reversible either. */
const CLIENT_HINT_CHARS = 12

const REDACTED = '[redacted]'

// --- field sanitizers --------------------------------------------------------

/**
 * Normalize an action to the `area.verb` vocabulary: lowercase, and only
 * `[a-z0-9._-]`. Charset-restricting the column means a caller CANNOT smuggle
 * content through it even before the length cap applies.
 *
 * scrubAuditText bounds before it scans, so a caller who passes a novel here
 * costs one slice, not a full scan of the novel.
 */
export function sanitizeAction(raw: unknown): string {
  const cleaned = scrubAuditText(raw, ACTION_MAX_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, ACTION_MAX_CHARS)
    // Trimmed AFTER the slice too, so a cut that lands mid-separator does not
    // leave 'jobs.score_' dangling.
    .replace(/^[._-]+|[._-]+$/g, '')
  // access_code_events.action is NOT NULL, and a row that says only "something
  // happened" is still worth more to the owner than a dropped event.
  return cleaned || 'unknown'
}

/**
 * A route or object reference. Query string and fragment are DISCARDED before
 * anything else: `?q=...` is where a search term, an email address or a
 * one-time token rides along, and none of that belongs in an audit row.
 *
 * BOUND, THEN SPLIT, THEN SCRUB. Every step before the cap has to be cheap: a
 * 50MB "target" must not be split into fragments, walked by four regexes and
 * character-mapped only to be thrown away at .slice(0, 200). Cutting first
 * costs a string slice and nothing else. Nothing is lost by cutting early
 * either — anything past the cap could never have reached the column.
 */
export function sanitizeTarget(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const withoutQuery = boundForScrub(raw, TARGET_MAX_CHARS).split(/[?#]/)[0] ?? ''
  const cleaned = scrubAuditText(withoutQuery, TARGET_MAX_CHARS).slice(0, TARGET_MAX_CHARS).trim()
  return cleaned || null
}

/** Detail values are scalars only — see sanitizeDetail. */
export type AccessEventDetailValue = string | number | boolean | null
export type AccessEventDetail = Record<string, AccessEventDetailValue>

/**
 * Key names that carry content in this codebase's own vocabulary and that
 * deepScrub's list does not already cover. Both lists are matched against the
 * key with separators removed, so `client_ip`, `clientIp` and `CLIENTIP` hit.
 *
 * SHORT NAMES ARE MATCHED EXACTLY, long ones as substrings. A substring rule on
 * 'ip' would eat `skipped`; on 'code' it would eat `encoded`; on 'text' it would
 * eat `contextId`. Losing those to over-redaction costs the owner real context
 * for no privacy gain, since the shape allow-list (isRecordableToken) already
 * bounds what any of them could contain.
 */
const CONTENT_KEY_EXACT = new Set([
  'ip', 'ips', 'clientip', 'remoteip', 'serverip', 'ipaddress',
  'ua', 'useragent', 'cookie', 'cookies', 'referer', 'referrer',
  'url', 'uri', 'href', 'link', 'q', 'query', 'search',
  'code', 'codes', 'hash', 'body', 'text', 'msg', 'note', 'notes',
  'prompt', 'content', 'answer', 'answers', 'subject', 'snippet',
  'excerpt', 'description', 'summary', 'title',
  'raw', 'payload', 'input', 'output',
])

/** Unambiguous enough to match anywhere in a key name. */
const CONTENT_KEY_RE =
  /(accesscode|codehash|plaintext|fulltext|resumetext|emailbody|messagebody|useragent|ipaddress|apikey|secret|password|credential|token|prompt|transcript|freetext)/

function keyCarriesContent(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return CONTENT_KEY_EXACT.has(normalized) || CONTENT_KEY_RE.test(normalized)
}

function sanitizeKey(key: string): string | null {
  // Bounded before the replaces, for the same reason every other field is: a
  // hostile caller can make the KEY the huge one.
  const cleaned = boundForScrub(key, DETAIL_MAX_KEY_CHARS)
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, DETAIL_MAX_KEY_CHARS)
    .replace(/^_+|_+$/g, '')
  return cleaned || null
}

/**
 * Reduce one value to a loggable scalar, or undefined to drop it.
 *
 * THE SHAPE RULE (isRecordableToken, in ./scrub.ts): a surviving string must be
 * short and must LOOK LIKE one of the things this table is for — an id, a uuid,
 * an enum, a slug, an event timestamp. Everything else goes: prose (it has
 * whitespace), an email (it has '@'), a URL or path (it has '/'), a phone
 * number or SSN or card or ZIP or date of birth (too many digits, together or
 * in total), an API key or session id (too many alphanumerics, in one run or
 * across the whole value), and any value that had to be redacted (it carries a
 * marker, and a redaction is not a fact worth storing — `_dropped` counts it
 * instead). A uuid and a timestamp-with-a-time-of-day are the only long shapes
 * that survive, and both are matched by exact pattern.
 *
 * That is an ALLOW-LIST, and it is deliberately the last word: the pattern list
 * in lib/observability/scrub.ts can only catch secret formats someone has
 * already met, and this is the layer that still holds for the next one.
 *
 * BOUNDS COME FIRST. A string is cut to size before deepScrub or any redaction
 * touches it, and a non-scalar is dropped without being WALKED at all — a
 * 10,000-key nested object under an innocuous name used to be fully scrubbed on
 * its way to being discarded.
 *
 * `rawKey` (not the sanitized one) is handed to deepScrub so its key deny-list
 * sees the name the caller actually used.
 */
function sanitizeValue(rawKey: string, value: unknown): AccessEventDetailValue | undefined {
  if (keyCarriesContent(rawKey)) return undefined
  // An explicitly absent value is noise, not a fact worth a column. `null` is
  // kept, because a caller writing null is saying something.
  if (value === undefined) return undefined
  // Objects and arrays are dropped, not flattened: nesting is exactly how a
  // blob of content arrives somewhere nobody thought to look. Dropped BEFORE
  // deepScrub so a pathological structure is never walked.
  if (value !== null && typeof value === 'object') return undefined

  const bounded = typeof value === 'string' ? boundForScrub(value, DETAIL_MAX_VALUE_CHARS) : value
  // Still handed to deepScrub whatever its type: its key deny-list must be able
  // to redact `{ token: 5 }`, not just string values.
  const scrubbed = deepScrub(bounded, rawKey)
  // deepScrub collapses a value under a sensitive key name to this exact
  // marker. Drop the key outright rather than storing a row of markers.
  if (scrubbed === REDACTED) return undefined

  if (scrubbed === null || scrubbed === undefined) return null
  if (typeof scrubbed === 'boolean') return scrubbed
  if (typeof scrubbed === 'number') return Number.isFinite(scrubbed) ? scrubbed : undefined
  if (typeof scrubbed !== 'string') return undefined

  const text = redactCodesAndIps(scrubbed).trim()
  if (!text) return undefined
  if (text.length > DETAIL_MAX_VALUE_CHARS) return undefined
  if (!isRecordableToken(text)) return undefined
  return text
}

/** Serialized cost of one key/value pair, used for the byte backstop. */
function entryBytes(key: string, value: AccessEventDetailValue): number {
  return Buffer.byteLength(`${JSON.stringify(key)}:${JSON.stringify(value)},`)
}

/**
 * Bound and scrub the structured extras.
 *
 * Whatever is dropped is COUNTED, not hidden: `_dropped` tells the owner the
 * caller tried to say more than the rules allow, which is the signal you want
 * when a new call site is quietly losing half its context.
 */
export function sanitizeDetail(raw: unknown): AccessEventDetail {
  const out: AccessEventDetail = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  // Reserve room for the marker so adding it can never push the row over.
  const budget = DETAIL_MAX_BYTES - Buffer.byteLength('{"_dropped":9999}')
  let used = 2 // '{}'
  let dropped = 0
  let scanned = 0

  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (++scanned > DETAIL_MAX_ENTRIES_SCANNED) {
      dropped++
      break
    }
    if (Object.keys(out).length >= DETAIL_MAX_KEYS) {
      dropped++
      continue
    }
    const key = sanitizeKey(rawKey)
    const value = key === null ? undefined : sanitizeValue(rawKey, rawValue)
    if (key === null || value === undefined) {
      dropped++
      continue
    }
    const cost = entryBytes(key, value)
    if (used + cost > budget) {
      dropped++
      continue
    }
    out[key] = value
    used += cost
  }

  if (dropped > 0) out._dropped = dropped
  return out
}

// --- client hint -------------------------------------------------------------

/**
 * HMAC key for client hints.
 *
 * WHY IT IS KEYED AND NOT A PLAIN HASH: a 48-bit truncated SHA-256 of
 * "user-agent + IP" is not anonymous. IPv4 is only 2^32 addresses and user-agent
 * strings are guessable, so anyone holding this table could confirm "this visit
 * came from 203.0.113.7" by brute force in seconds — turning a field documented
 * as coarse into an exact IP disclosure. Keying it with a server-side secret
 * removes that offline attack entirely.
 *
 * Read per call rather than at import so a process that loads its secrets late
 * (and the tests) see the value that is actually configured.
 */
function hintKey(): string {
  return (
    process.env.API_ENCRYPTION_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    // Last resort. Hints stay stable and usable; they are simply no longer
    // brute-force resistant, which is why every real deployment sets one of
    // the above.
    'cello-access-hint'
  )
}

/**
 * Coarsen an address before it is ever hashed: IPv4 to its /24, IPv6 to its
 * /48. Two independent reasons, both pointing the same way:
 *   * PRIVACY — even hashed, the input should not be a unique identifier.
 *   * USEFULNESS — a phone that moves between towers keeps one hint instead of
 *     fragmenting into five, which is precisely what "tell two people apart"
 *     needs.
 */
function coarsenIp(ip: string): string {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`
  return ip
}

/**
 * A coarse, non-reversible attribution hint. The owner needs to tell two people
 * apart over 72 hours; they do not get to track anyone.
 *
 * Returns undefined when there is no signal at all, so the column stays NULL
 * rather than storing the hash of an empty string (which would make every
 * signal-less request look like the same visitor).
 */
export function clientHint(input: { userAgent?: string | null; ip?: string | null }): string | undefined {
  const ua = (input.userAgent || '').trim().slice(0, 300)
  const ip = (input.ip || '').trim().slice(0, 60)
  if (!ua && !ip) return undefined
  return createHmac('sha256', hintKey())
    .update(`${ua}\n${ip ? coarsenIp(ip) : ''}`)
    .digest('hex')
    .slice(0, CLIENT_HINT_CHARS)
}

/**
 * Same hint, derived from a request's headers.
 *
 * x-forwarded-for is client-controllable, and that is acceptable HERE and only
 * here: the hint is advisory context for a human reading a list, never an
 * authentication or authorization input. Nothing downstream may branch on it.
 */
export function clientHintFromHeaders(headers: Headers): string | undefined {
  const forwarded = headers.get('x-forwarded-for') || ''
  const ip =
    forwarded.split(',')[0]?.trim() ||
    headers.get('cf-connecting-ip') ||
    headers.get('x-real-ip') ||
    ''
  return clientHint({ userAgent: headers.get('user-agent'), ip })
}

/**
 * Last line of defence on the hint column: anything that is not already a hint
 * is HASHED INTO ONE rather than stored. A caller who passes a raw IP or a raw
 * user-agent by mistake therefore cannot put it in the table — the wrong call
 * still produces a coarse hint, just a differently-derived one.
 */
export function coerceClientHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (new RegExp(`^[0-9a-f]{${CLIENT_HINT_CHARS}}$`).test(trimmed)) return trimmed
  return clientHint({ userAgent: trimmed })
}

// --- the deadline ------------------------------------------------------------

/**
 * The whole wall-clock budget one audit write may take from the request it
 * describes — the auth round trip, the profile and code lookups AND the insert,
 * not just the insert.
 *
 * WHY A NUMBER AT ALL. Every caller awaits the trail (Next 14 route handlers
 * have no after()/waitUntil, so a floating promise is an event lost when the
 * process is torn down after the response). Awaiting an UNBOUNDED write means a
 * Supabase call that hangs — a connection that is accepted and never answered,
 * a pooler at capacity — consumes the handler's entire `maxDuration` and turns
 * a request that had already succeeded into a gateway timeout. That is the
 * audit trail breaking the thing it audits, which is the one thing it may
 * never do.
 *
 * WHY TWO SECONDS. Long enough that a healthy insert (single-digit to low tens
 * of milliseconds against a warm connection) never trips it, so the deadline
 * costs the trail no rows in normal operation. Short enough to be a rounding
 * error against the handlers that carry it: the routes it runs on declare
 * maxDuration of 30-300s and have just spent most of that on LLM calls or
 * outbound HTTP.
 */
export const AUDIT_DEADLINE_MS = 2_000

const DEADLINE_MESSAGE = `audit write abandoned after ${AUDIT_DEADLINE_MS}ms`

/**
 * Await `work` for at most AUDIT_DEADLINE_MS. Returns null when it finished in
 * time, or a message describing what went wrong (a failure, or the deadline).
 *
 * WHAT THIS DOES AND DOES NOT DO. It bounds how long the CALLER waits. It
 * cannot cancel the work — supabase-js exposes no AbortSignal on a PostgREST
 * insert — so an abandoned write may still land in the table afterwards. That
 * is the acceptable direction to be wrong in: a duplicate-looking late row is a
 * cosmetic problem in the owner's timeline, a request that 504s because its
 * audit row was slow is an outage.
 *
 * IT RESOLVES IN EVERY CASE, INCLUDING FAILURE. `work`'s rejection is converted
 * into a returned message before the race, so a caller sitting on a response
 * path is never handed an exception by its own audit trail — which is the whole
 * reason recordAccessEvent and recordDemoEvent can promise not to throw.
 *
 * A consequence, stated as a consequence rather than as this line's purpose: a
 * write that fails AFTER the deadline has already lost is still a handled
 * rejection. Promise.race attaches handlers to every input, so that would hold
 * without the conversion too — it is belt and braces, not a guarantee this line
 * uniquely provides, and the test file says so.
 */
export async function withAuditDeadline(work: () => Promise<unknown>): Promise<string | null> {
  let settled: Promise<string | null>
  try {
    settled = Promise.resolve(work()).then(
      () => null,
      (err) => (err instanceof Error ? err.message : String(err))
    )
  } catch (err) {
    // `work` threw before it ever produced a promise — a client that is not a
    // client at all, say. There is nothing to race.
    return err instanceof Error ? err.message : String(err)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_MESSAGE), AUDIT_DEADLINE_MS)
  })

  try {
    return await Promise.race([settled, deadline])
  } finally {
    // Cleared on BOTH outcomes. A pending timer holds the Node event loop open,
    // which in a serverless handler is billed time and in a test run is a suite
    // that does not exit.
    if (timer !== undefined) clearTimeout(timer)
  }
}

// --- the write ---------------------------------------------------------------

export interface AccessEventInput {
  /** access_codes.id this activity belongs to. */
  codeId: string
  kind: AccessEventKind
  /** App vocabulary, e.g. 'jobs.score_batch'. Normalized, never trusted. */
  action: AccessEventAction
  /** Route or object touched. Query string and fragment are discarded. */
  target?: string | null
  /** Counts, ids and enums only — see sanitizeDetail's no-prose rule. */
  detail?: Record<string, unknown> | null
  /** Output of clientHint() / clientHintFromHeaders(); anything else is hashed. */
  clientHint?: string | null
}

/** The row shape written to access_code_events. */
export interface AccessEventRow {
  code_id: string
  kind: AccessEventKind
  action: string
  target: string | null
  detail: AccessEventDetail
  client_hint: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Build the row without touching the database.
 *
 * Separated from the write so the sanitizing rules — the part that actually
 * protects anyone — are testable as a pure function, with no fake client
 * standing between the assertion and the policy. Returns null when the event
 * cannot be attributed to a code, since an unattributed audit row is noise the
 * owner can neither read nor act on.
 */
export function buildAccessEventRow(input: AccessEventInput): AccessEventRow | null {
  const codeId = typeof input?.codeId === 'string' ? input.codeId.trim() : ''
  if (!UUID_RE.test(codeId)) return null

  const kind = (ACCESS_EVENT_KINDS as readonly string[]).includes(input.kind as string)
    ? (input.kind as AccessEventKind)
    : 'action'

  return {
    code_id: codeId,
    kind,
    action: sanitizeAction(input.action),
    target: sanitizeTarget(input.target),
    detail: sanitizeDetail(input.detail),
    client_hint: coerceClientHint(input.clientHint) ?? null,
  }
}

/**
 * Record one event against an access code.
 *
 * `admin` MUST be the service-role client (lib/harness/supabase-admin.ts
 * createAdminClient()): access_code_events has no insert policy, so a
 * cookie-scoped client would be rejected by RLS and this would log a failure on
 * every single call.
 *
 * Never throws and never rejects, and never takes longer than
 * AUDIT_DEADLINE_MS — see the file header. Safe to `void`.
 */
export async function recordAccessEvent(
  admin: SupabaseClient,
  input: AccessEventInput
): Promise<void> {
  let built: AccessEventRow | null
  try {
    built = buildAccessEventRow(input)
  } catch (err) {
    logAuditFailure(input, err instanceof Error ? err.message : String(err))
    return
  }
  if (!built) {
    logAuditFailure(input, 'event has no valid codeId to attribute it to')
    return
  }
  // `const`, so the narrowing survives into the closure below.
  const row = built

  // Sanitizing is pure and bounded, so only the insert is put under the
  // deadline — a caller is never charged for a hang that cannot happen.
  const failure = await withAuditDeadline(async () => {
    const { error } = await admin.from(EVENTS_TABLE).insert(row)
    if (error) throw new Error(error.message)
  })
  if (failure) logAuditFailure(input, failure)
}

/** How much of a failure message is worth a log line. A DB error is a sentence;
 *  anything longer is a payload echoed back at us. */
const LOG_MESSAGE_MAX_CHARS = 300

/**
 * What may be said about a codeId on stderr.
 *
 * A uuid is an id and is logged as itself — that is the whole point of the
 * line. ANYTHING ELSE IS NOT LOGGED AT ALL, because this function runs
 * precisely when something has already gone wrong, which is exactly when the
 * caller is most likely to have passed the wrong thing — and the single most
 * likely wrong thing, in this feature, is the PLAINTEXT ACCESS CODE. stderr has
 * no RLS, ships to whatever log aggregator is configured, and is read by people
 * who never signed up to hold a bearer credential.
 *
 * So the shape is the diagnostic: 'not-a-uuid' plus a length. A developer
 * chasing this already knows the call site from `action`, and no scrubber can
 * be trusted more than simply not writing the value down.
 */
function loggableCodeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (UUID_RE.test(trimmed)) return trimmed
  return `not-a-uuid(${Math.min(trimmed.length, 9999)})`
}

/**
 * One structured stderr line, matching lib/observability/log.ts's shape.
 *
 * Logs the ATTRIBUTION ONLY (code id, kind, action) — never `detail`, `target`
 * or the client hint. The payload failed to reach a table that has been
 * carefully bounded; dumping the unbounded original into the process log
 * instead would defeat the entire point of this module. The message itself is
 * scrubbed and capped too: a PostgREST error quotes the offending value back at
 * you, and that value came from a caller.
 */
function logAuditFailure(input: AccessEventInput, message: string): void {
  console.error(
    `[access:audit] ${JSON.stringify({
      at: new Date().toISOString(),
      scope: 'access-audit',
      codeId: loggableCodeId(input?.codeId),
      kind: typeof input?.kind === 'string' ? sanitizeAction(input.kind) : null,
      action: sanitizeAction(input?.action),
      message: scrubAuditText(message, LOG_MESSAGE_MAX_CHARS).slice(0, LOG_MESSAGE_MAX_CHARS),
    })}`
  )
}
