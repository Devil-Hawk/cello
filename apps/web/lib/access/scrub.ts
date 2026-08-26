// The text gate for the demo access-code audit trail.
//
// One question, asked in one place: what is a string allowed to look like
// before it may reach access_code_events — or stderr, which is the same
// question with a different destination and no RLS in front of it at all.
//
// THE ORDER OF OPERATIONS IS ITSELF A SECURITY PROPERTY
//
//   1. BOUND FIRST. Every function here is bounded-input-only, and callers cap
//      with boundForScrub BEFORE the first pattern runs. Scrubbing is regex and
//      table work over the WHOLE string; doing it to 50MB of caller-supplied
//      text and only then slicing to 200 characters is a free CPU denial of
//      service for anyone who can name an audit field. Bound, then scrub.
//   2. REDACT what is recognisably a secret: the shared Sentry pattern policy
//      (lib/observability/scrub.ts — one policy in this codebase, not two that
//      drift), then IP addresses, then anything redeemable as an access code.
//   3. ALLOW-LIST what may survive into `detail`. A deny-list answers "is this
//      one of the secrets we have thought of"; an allow-list answers "is this
//      one of the shapes we meant to record", and only the second one holds
//      when the caller leaks something nobody has a pattern for yet.
//
// WHY THIS IS NOT INSIDE audit.ts
//   The access-code redaction below is DERIVED FROM lib/access/codes.ts's
//   normalizer rather than restating it. That derivation is the whole reason
//   the two cannot drift apart again, so it deserves to be read — and tested —
//   on its own rather than buried among row builders.
//
// Server-only. Never import from a client component.

import { deepScrub } from '@/lib/observability/scrub'
import { generateAccessCode, looksLikeAccessCode, normalizeAccessCode } from './codes'

// --- bounding ----------------------------------------------------------------

/**
 * How far past a field's own cap the scan still reaches.
 *
 * Not zero, and that is deliberate: slicing at EXACTLY the cap can cut a
 * credential in half and leave the surviving half in the column — 8 of the 12
 * characters of an access code is a materially easier code to guess than none.
 * Scanning a little past the cap means anything straddling it is recognised
 * whole, redacted whole, and only then cut (into a piece of a marker, which is
 * harmless).
 *
 * 256 characters comfortably covers every fixed-shape secret this gate knows
 * about. A single token longer than that which straddles the cap can still be
 * truncated — but a truncated 500-character JWT is not a usable credential, and
 * the alternative (no bound at all) is the denial of service above.
 */
export const SCRUB_OVERLAP_CHARS = 256

/** Cut the input down to what could possibly matter, before any scan runs. */
export function boundForScrub(raw: string, cap: number): string {
  const limit = Math.max(0, cap) + SCRUB_OVERLAP_CHARS
  return raw.length > limit ? raw.slice(0, limit) : raw
}

// --- control characters ------------------------------------------------------

/** Control characters, including newlines: an audit value that can inject a
 *  line break can forge a second log line wherever this is rendered. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]+/g

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ')
}

// --- access codes ------------------------------------------------------------

const CODE_MARKER = '[redacted-code]'

/**
 * THE GUARANTEE
 *   Every substring of the input that normalizes to a redeemable access code is
 *   removed IN FULL. Not "every run shaped like the display form", not "every
 *   match of a pattern someone wrote down twice" — every substring the
 *   redemption endpoint would accept.
 *
 * HOW IT CANNOT DRIFT
 *   The scan runs over the NORMALIZED text and maps back to source offsets, so
 *   the separators it tolerates are by construction exactly the ones
 *   normalizeAccessCode strips, the alphabet is exactly the one
 *   looksLikeAccessCode accepts, and the width is exactly what
 *   generateAccessCode produces. There is no second copy of any of those rules
 *   here to fall out of step: a spelling like 'P7QK.3M9X.TCR2' or an en dash
 *   from autocorrect still redeems, so it still redacts — automatically.
 *
 * WHY THE UNION OF EVERY WINDOW, AND NOT THE FIRST MATCH
 *   Candidates overlap. A first-match-then-resume redactor, handed the doubled
 *   code 'P7QK-3M9X-TCR2P7QK-3M9X-TCR2', redacted the ROTATION in the middle
 *   and left 'P7QK-' and '-3M9X-TCR2' on either side of the marker — two
 *   fragments any reader reassembles into a working code by deleting the
 *   marker. Redacting the union of every accepted window cannot leave such a
 *   pair: an embedded code is always one contiguous window, and every
 *   contiguous window that could be a code is gone.
 *
 * THE COST, STATED PLAINLY
 *   Over-redaction, and more of it than a shape pattern would produce. An id
 *   that sits entirely inside the code alphabet becomes '[redacted-code]', and
 *   ordinary words touching a real code are swallowed with it (they are joined
 *   to it by a separator, so they are part of the same redeemable window). The
 *   owner loses a little context. The alternative is a WORKING BEARER
 *   CREDENTIAL in a table the owner can read and export, so this is the trade
 *   to keep making.
 */
export function redactAccessCodes(text: string): string {
  if (!text) return text
  const width = codeWidth()

  // Normalized characters, each remembering the source span it came from. One
  // source character can contribute more than one normalized character (a
  // ligature uppercases into two letters), which is precisely the kind of case
  // a hand-written separator pattern misses and this mapping does not.
  const norm: string[] = []
  const spanStart: number[] = []
  const spanEnd: number[] = []
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!)
    const produced = contribution(ch)
    for (const c of produced) {
      norm.push(c)
      spanStart.push(i)
      spanEnd.push(i + ch.length)
    }
    i += ch.length
  }
  if (norm.length < width) return text

  // Sliding run of characters that could appear in a code, then the real
  // predicate on the candidate window. The cheap counter keeps this linear; the
  // confirmation keeps looksLikeAccessCode the authority on what a code is.
  const ranges: Array<[number, number]> = []
  let run = 0
  for (let i = 0; i < norm.length; i++) {
    run = isCodeChar(norm[i]!) ? run + 1 : 0
    if (run < width) continue
    const from = i - width + 1
    if (!looksLikeAccessCode(norm.slice(from, i + 1).join(''))) continue
    const lo = spanStart[from]!
    const hi = spanEnd[i]!
    const last = ranges[ranges.length - 1]
    // Windows are produced left to right, so overlapping or touching ranges are
    // always adjacent in this list — merging keeps one marker per run.
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else ranges.push([lo, hi])
  }
  if (ranges.length === 0) return text

  let out = ''
  let cursor = 0
  for (const [lo, hi] of ranges) {
    out += text.slice(cursor, lo) + CODE_MARKER
    cursor = hi
  }
  return out + text.slice(cursor)
}

/**
 * The code width, asked of the generator rather than restated.
 *
 * Derived lazily (and once) so importing this module costs no entropy, and so a
 * change to CODE_LENGTH in codes.ts cannot leave this scanner looking for the
 * wrong number of characters.
 */
let cachedWidth = 0
function codeWidth(): number {
  if (!cachedWidth) cachedWidth = normalizeAccessCode(generateAccessCode()).length
  return cachedWidth
}

/**
 * Bounded memo tables. The inputs here are already capped by boundForScrub, but
 * these caches outlive a single call, so they get their own ceiling rather than
 * growing with every distinct character the process ever sees.
 */
const MEMO_MAX_ENTRIES = 1024
const contributionMemo = new Map<string, string>()
const codeCharMemo = new Map<string, boolean>()

/** What the normalizer turns one source character into: '' for a separator it
 *  strips, otherwise the character(s) a code would actually contain. */
function contribution(ch: string): string {
  const hit = contributionMemo.get(ch)
  if (hit !== undefined) return hit
  const value = normalizeAccessCode(ch)
  if (contributionMemo.size < MEMO_MAX_ENTRIES) contributionMemo.set(ch, value)
  return value
}

/** Is this normalized character one a code can be made of? Asked of
 *  looksLikeAccessCode so the alphabet is never copied into this file. */
function isCodeChar(ch: string): boolean {
  const hit = codeCharMemo.get(ch)
  if (hit !== undefined) return hit
  const value = looksLikeAccessCode(ch.repeat(codeWidth()))
  if (codeCharMemo.size < MEMO_MAX_ENTRIES) codeCharMemo.set(ch, value)
  return value
}

// --- IP addresses ------------------------------------------------------------

/**
 * IPv4 dotted quads and IPv6 (including '::' compression).
 *
 * lib/observability/scrub.ts does not carry this pattern because Sentry
 * legitimately wants a server address in a stack trace. Here it is forbidden
 * outright: "no full IP address" is a stated rule of this table, and an IP is
 * the one piece of PII that survives every other layer — it is short, has no
 * whitespace, and matches no secret format. Over-redaction (a version string
 * like 10.0.0.1) is the accepted cost.
 */
const IP_RE =
  /(?<![\w.:])(?:(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4})(?![\w.:])/gi

export function redactIps(text: string): string {
  return text.replace(IP_RE, '[redacted-ip]')
}

/**
 * This feature's own two redactions, in the order that matters: addresses
 * first, then codes.
 *
 * WHY THAT ORDER: the code scan treats '.' as a separator (the normalizer
 * does), so a dotted quad sitting next to a real code can fall inside the same
 * redeemable window and be swallowed HALF-way, leaving a mangled address the IP
 * pattern no longer recognises. Redacting addresses first replaces them with a
 * marker whose brackets are not separators, which also stops the code scan from
 * reaching across them. The reverse order cannot lose a code — a code with
 * colons or dotted-decimal digits is not redeemable — so this order is strictly
 * safer.
 */
export function redactCodesAndIps(text: string): string {
  return redactAccessCodes(redactIps(text))
}

/**
 * The one text gate, applied to every string that reaches a column: bound,
 * strip control characters, run the shared secret/PII pattern policy, then this
 * feature's address and access-code redaction.
 */
export function scrubAuditText(raw: unknown, cap: number): string {
  if (typeof raw !== 'string' || raw === '') return ''
  const patterned = deepScrub(stripControlChars(boundForScrub(raw, cap)))
  return redactCodesAndIps(typeof patterned === 'string' ? patterned : '').trim()
}

// --- what may survive into `detail` ------------------------------------------

/**
 * Shapes a recorded value is allowed to have: groups of ASCII letters and
 * digits joined by single '.', '_', ':' or '-'. Ids, uuids, enums, slugs, model
 * names and ISO timestamps are all of this shape.
 *
 * It is an ALLOW-LIST, so what it rejects is everything else: anything with
 * whitespace (prose), '@' (an email address), '/' (a path or URL), '+' (an
 * international phone number), '=' or '%' (base64 and percent-encoding), '&' or
 * '?' (a query string), quotes, and any non-ASCII text.
 */
const RECORDABLE_SHAPE_RE = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/

/**
 * The two long shapes worth an exception, named EXACTLY rather than inferred.
 *
 * Everything below this is a length-and-digit budget, and a uuid blows through
 * all of it: 32 alphanumerics, and roughly one uuid in 200 has a group of
 * twelve straight digits. A uuid is also the most useful thing this table can
 * hold — it is how the owner ties a row to a job — so it is allow-listed by its
 * exact shape rather than by loosening a rule everything else lives under.
 *
 * The timestamp exception REQUIRES a time of day, and that is the entire point:
 * '2026-08-03T11:22:33Z' is when something happened, while a bare '1989-04-17'
 * is a date of birth, and no code downstream can tell those two apart. So the
 * bare date stays outside the exception and dies on the digit budget below.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z?$/

/**
 * The digit budget. Phone numbers, SSNs, card numbers, ZIPs and dates of birth
 * are all just digits, and nothing legitimate here needs many: a genuine count
 * arrives as a NUMBER, not as a numeric string.
 *
 * TWO caps, because either alone has a hole. The RUN cap stops a 5-digit ZIP
 * and a 6-digit date of birth ('890417'); the TOTAL cap stops the same values
 * spelled with separators, which no run cap can see — '415-555-0134',
 * '4111-1111-1111-1111', 'ssn-123-45-6789'.
 *
 * BOTH ARE MEASURED ANYWHERE IN THE VALUE, not only on values that are digits
 * end to end. The rule this replaces tested the whole string, so a single
 * letter switched it off completely: 'tel:4155550134', 'user-4155550134',
 * 'ssn-123456789' and 'DOB19890417' were all recorded verbatim.
 */
const MAX_DIGIT_RUN = 4
const MAX_TOTAL_DIGITS = 6

/**
 * The opaque-token budget, counted in alphanumerics (separators are free).
 *
 * Again two caps, and again because either alone has a hole. The RUN cap is the
 * old rule: an unbroken 16-character alphanumeric run is not an id anyone chose
 * to be readable. The TOTAL cap is the one that was missing, and its absence
 * was the bug — the run cap only ever looked INSIDE a separator-delimited
 * segment, so a 38-character dashed API key and a 26-character dotted token
 * walked through it four characters at a time. Splitting a secret with dashes
 * must not launder it.
 *
 * The run cap also no longer asks whether the run mixes letters and digits. It
 * used to, on the reasoning that letters alone are "a word or a name" — which
 * is exactly what a 32-character letters-only secret counts on. A word that
 * long has no business in an audit column either.
 *
 * THE COST, STATED PLAINLY: a long readable slug ('senior-staff-platform-engineer')
 * is dropped and counted in `_dropped`. Call sites are expected to pass counts,
 * enums and uuids, all of which fit.
 */
const OPAQUE_RUN_CHARS = 16
const MAX_ALNUM_CHARS = 20

/**
 * May this (already scrubbed) string be written to `detail`?
 *
 * WHAT THIS GUARANTEES: nothing reaches the column that contains whitespace
 * (prose), '@' (an email), '/' (a path or URL), or any character outside
 * `[A-Za-z0-9._:-]`; nothing carrying a redaction marker (a value that had to
 * be redacted is not a fact worth keeping, and `_dropped` counts it instead —
 * the brackets fail the shape rule); nothing with more than four digits in a
 * row or six digits in all; and nothing with a sixteen-character unbroken
 * alphanumeric run or more than twenty alphanumerics in total. Exactly two long
 * shapes are exempt, by exact pattern: a canonical uuid, and an ISO timestamp
 * that carries a time of day.
 *
 * WHAT IT CANNOT DO: tell an id from a short word. `{ candidate: 'ankit' }` is
 * indistinguishable from `{ stage: 'applied' }` at this layer, and both are
 * recorded. The key deny-list, and call sites that pass counts and enums rather
 * than content, are what cover that — this is the floor, not the ceiling.
 */
export function isRecordableToken(text: string): boolean {
  if (!RECORDABLE_SHAPE_RE.test(text)) return false
  if (UUID_RE.test(text) || ISO_TIMESTAMP_RE.test(text)) return true

  // One pass, no allocation: this runs on every value of every audit event, and
  // the shape rule above has already guaranteed the alphabet.
  let digits = 0
  let digitRun = 0
  let alnum = 0
  let alnumRun = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    const isDigit = ch >= 48 && ch <= 57
    const isAlnum = isDigit || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)
    digitRun = isDigit ? digitRun + 1 : 0
    alnumRun = isAlnum ? alnumRun + 1 : 0
    if (digitRun > MAX_DIGIT_RUN || alnumRun >= OPAQUE_RUN_CHARS) return false
    if (isDigit) digits++
    if (isAlnum) alnum++
  }
  return digits <= MAX_TOTAL_DIGITS && alnum <= MAX_ALNUM_CHARS
}
