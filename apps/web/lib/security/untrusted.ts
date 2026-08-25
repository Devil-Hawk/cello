// Defenses for calling things Cello does not control: user-configured MCP
// servers (lib/mcp/client.ts, lib/mcp/registry.ts) and third-party employer
// sites (lib/ats-apply/*, lib/sources/*, lib/ats/*). Both dispatch into, or
// fetch from, a REMOTE endpoint someone else runs — a malicious or merely
// broken one is an arbitrary-input source sitting inside the copilot's loop
// or the apply pipeline.
//
// WHAT THIS IS NOT — read this before trusting anything below
//   This is NOT sandboxing and NOT container isolation. A Next.js serverless
//   function runs untrusted-server RESPONSES (data) inside the same process,
//   memory space, and OS as everything else Cello does; there is no seccomp
//   profile, no gVisor/Firecracker boundary, no separate container per call.
//   Cello has already had to walk back one capability lie
//   (lib/automation/capabilities.ts — a switch that claimed to auto-submit
//   applications and didn't); claiming "sandboxed" here would be the same
//   mistake in a more dangerous place. What this module actually provides is
//   NETWORK-LAYER egress control and PAYLOAD control, both enforced in plain
//   TypeScript before/around the call:
//     - refuse to even attempt a request whose target resolves to an address
//       Cello has no business reaching (loopback / link-local / RFC1918 / a
//       cloud metadata endpoint) — closes the highest-value hole, credential
//       exfiltration via a user-supplied URL pointing at 169.254.169.254
//     - refuse to buffer an unbounded response body
//     - bound how long Cello waits on a call that may never answer
//     - keep a namespaced tool name from ever equaling a built-in one
//   None of this stops a remote TOOL RESULT from containing an instruction-
//   shaped string ("ignore previous instructions...") — that is a PROMPT
//   framing problem, already handled at the point results re-enter the
//   model's context (see MCP_SAFETY_PREFACE in lib/mcp/registry.ts and the
//   note attached to every dispatchMcpTool() result in
//   lib/harness/copilot-tools.ts). This module's job stops at "is it safe to
//   send the request and safe to hold the response," not "is the response's
//   content safe to believe."
//
// TOCTOU CAVEAT — also read before trusting the SSRF guard specifically
//   checkSsrf() below resolves DNS itself, once, at check time. The fetch()
//   call a caller makes afterwards does its OWN independent DNS resolution
//   when it actually connects. Nothing in a stock `fetch` lets a caller pin
//   the connection to the address this module just verified, so a resolver
//   that returns a public address on the check and a private one moments
//   later (DNS rebinding) is a real, NOT-fully-closed gap. The mitigations
//   that exist elsewhere narrow it further and should stay in place
//   alongside this module: lib/ats/http.ts and lib/ats-apply/http.ts already
//   set `redirect: 'error'` (a rebinding-via-redirect can't silently land
//   you on a new host) and pair SSRF checks with a fixed per-adapter host
//   allowlist (assertAllowedHost), which is strictly stronger than anything
//   in this file for the hosts it covers. Use checkSsrf() here for the case
///  those files don't have to deal with — a URL the USER supplied at
//   runtime (an MCP server endpoint), where there is no fixed allowlist to
//   check against because the whole point is that it's arbitrary.
//
// Node-runtime only: this uses node:dns and node:net, so it only works where
// those call sites already run (Node, not the Edge runtime) — true today for
// both lib/mcp and lib/ats-apply.

import { promises as dnsPromises } from 'node:dns'
import net from 'node:net'

/** Thrown by the throwing variants below (assertSsrfSafe, withTimeout,
 *  readLimitedBody). `code` lets a caller branch without string-matching
 *  `message`, same convention as lib/mcp/types.ts's McpError. */
export class UntrustedCallError extends Error {
  readonly code: 'blocked' | 'timeout' | 'too_large'
  constructor(message: string, code: 'blocked' | 'timeout' | 'too_large') {
    super(message)
    this.name = 'UntrustedCallError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * Hostnames refused without ever touching DNS — cheap, and covers the exact
 * strings someone would type by hand. `.local` (mDNS) and `.localhost` are
 * suffix checks; the rest are exact. This is DEFENSE IN DEPTH alongside the
 * IP-range check below, not a replacement for it: "localhost" also resolves
 * to 127.0.0.1 via normal DNS and would be caught there regardless.
 */
const BLOCKED_LITERAL_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  // GCP's metadata server is reachable by this hostname as well as by IP;
  // the IP check below catches it too (169.254.169.254 is link-local), but a
  // resolver that only this hostname is configured against is worth refusing
  // before it ever reaches DNS.
  'metadata.google.internal',
])

function isBlockedLiteralHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (BLOCKED_LITERAL_HOSTNAMES.has(h)) return true
  return h.endsWith('.localhost') || h.endsWith('.local')
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

function ipv4InRange(ip: string, base: string, maskBits: number): boolean {
  const ipInt = ipv4ToInt(ip)
  const baseInt = ipv4ToInt(base)
  if (ipInt === null || baseInt === null) return false
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0
}

/**
 * Every IPv4 block that is never a legitimate public destination for a
 * request Cello initiates. 169.254.0.0/16 is listed explicitly rather than
 * left implicit because it is the one that matters most here: AWS/GCP/Azure
 * all serve their instance-metadata (and hand out real cloud credentials)
 * from 169.254.169.254, so a user-supplied URL pointing there is a
 * credential-exfiltration path, not just an internal-network probe.
 */
const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" (RFC 791)
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // carrier-grade NAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — INCLUDES the cloud metadata endpoint 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // benchmarking (RFC 2544)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
]

/** True for any IPv4 address Cello should never connect to. */
export function isBlockedIpv4(ip: string): boolean {
  return IPV4_BLOCKED_RANGES.some(([base, bits]) => ipv4InRange(ip, base, bits))
}

/**
 * True for any IPv6 address Cello should never connect to: loopback (::1),
 * unspecified (::), link-local (fe80::/10, e.g. AWS's IMDS is also reachable
 * over link-local v6), unique-local (fc00::/7), and an IPv4-mapped address
 * (::ffff:a.b.c.d) whose embedded v4 address is itself blocked — checked in
 * BOTH the dotted-quad form ("::ffff:127.0.0.1", what a raw DNS AAAA-style
 * literal or a hand-typed URL tends to use) and the hex-group form
 * ("::ffff:7f00:1", what Node's own URL parser normalizes a bracketed IPv6
 * literal to — see the header's TOCTOU section for how that was verified).
 * Relies on the address already being in Node's own canonical/compressed
 * form (leading non-zero hextets are never touched by "::" compression, so
 * checking their literal prefix is reliable regardless of how much of the
 * rest of the address got compressed).
 */
export function isBlockedIpv6(ip: string): boolean {
  const a = ip.toLowerCase()
  if (a === '::1' || a === '::') return true
  // Compare the first hextet NUMERICALLY, not as a string pattern. The
  // previous /^fe[89ab][0-9a-f]?:/ and /^f[cd][0-9a-f]{0,2}:/ matched on shape,
  // which made the trailing hex digits optional and so caught addresses outside
  // the ranges they named: `fe8::1` is hextet 0x0fe8 and `fd:1::1` is 0x00fd —
  // both public, both blocked. That direction fails safe, but a guard that
  // blocks valid public addresses gets switched off, which fails very unsafe.
  const firstHextet = a.startsWith('::') ? 0 : parseInt(a.split(':')[0] || '0', 16)
  if (Number.isFinite(firstHextet)) {
    // fe80::/10 — link-local. Includes the IPv6 form of the metadata range.
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true
    // fc00::/7 — unique local (the IPv6 equivalent of RFC1918).
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true
  }

  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isBlockedIpv4(dotted[1])

  const hexGroups = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexGroups) {
    const h1 = parseInt(hexGroups[1], 16)
    const h2 = parseInt(hexGroups[2], 16)
    const ipv4 = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`
    return isBlockedIpv4(ipv4)
  }
  return false
}

/** Dispatch on address family (4 or 6, per node:net's isIP) to the matching check. */
export function isBlockedIp(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return false // not a syntactically valid IP at all — caller's problem, not ours
}

export type SsrfBlockReason =
  | 'invalid_url'
  | 'blocked_scheme'
  | 'blocked_hostname'
  | 'blocked_address'
  | 'dns_lookup_failed'

export type SsrfCheckResult =
  | { ok: true; hostname: string; addresses: string[] }
  | { ok: false; reason: SsrfBlockReason; message: string }

export interface SsrfCheckOptions {
  /**
   * Injectable resolver — defaults to node:dns's promises.lookup. Exists so
   * tests can exercise the "hostname resolves to a private address" path
   * without a real DNS round trip, and so a caller with its own resolution
   * policy (e.g. a private DNS zone it trusts) can supply one.
   */
  resolveHostname?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
}

/**
 * Non-throwing SSRF check for a URL Cello did not choose and does not
 * control the host of (a user-configured MCP server endpoint is the current
 * use case). Rejects non-http(s) schemes outright, then rejects a target
 * whose resolved address(es) are loopback / link-local / RFC1918 /
 * cloud-metadata space. See the TOCTOU section in this file's header for
 * what this check does and does not guarantee.
 *
 * A bracketed IPv6 literal or a bare IPv4 literal in the URL is checked
 * directly (no DNS involved — nothing to resolve). A real hostname is
 * resolved via `resolveHostname` and EVERY returned address is checked; one
 * blocked address among several is enough to reject the whole target, since
 * `fetch` itself picks which resolved address to connect to and Cello does
 * not get to choose which one that is.
 */
export async function checkSsrf(rawUrl: string, opts: SsrfCheckOptions = {}): Promise<SsrfCheckResult> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'invalid_url', message: `Not a valid URL: ${rawUrl}` }
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: 'blocked_scheme', message: `Scheme "${parsed.protocol}" is not allowed — only http/https.` }
  }

  // Bracketed IPv6 literal, e.g. "[::1]" -> "::1".
  if (parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')) {
    const ip = parsed.hostname.slice(1, -1)
    if (isBlockedIpv6(ip)) {
      return { ok: false, reason: 'blocked_address', message: `"${ip}" is a loopback/link-local/private IPv6 address.` }
    }
    return { ok: true, hostname: parsed.hostname, addresses: [ip] }
  }

  // Bare IPv4 literal — Node's URL parser already normalized decimal/octal/hex
  // obfuscation (e.g. "0x7f000001", "2130706433", "017700000001") to dotted-
  // quad form by the time we read .hostname, so a single range check here
  // covers all of those forms too (verified against Node's own URL parser;
  // see the module header).
  if (net.isIP(parsed.hostname) === 4) {
    if (isBlockedIpv4(parsed.hostname)) {
      return { ok: false, reason: 'blocked_address', message: `"${parsed.hostname}" is a loopback/link-local/private IPv4 address.` }
    }
    return { ok: true, hostname: parsed.hostname, addresses: [parsed.hostname] }
  }

  const hostname = stripTrailingDot(parsed.hostname)
  if (isBlockedLiteralHostname(hostname)) {
    return { ok: false, reason: 'blocked_hostname', message: `"${hostname}" is a blocked local/internal hostname.` }
  }

  const resolve = opts.resolveHostname ?? ((h: string) => dnsPromises.lookup(h, { all: true }))
  let records: Array<{ address: string; family: number }>
  try {
    records = await resolve(hostname)
  } catch (e) {
    return {
      ok: false,
      reason: 'dns_lookup_failed',
      message: `Could not resolve "${hostname}": ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (records.length === 0) {
    return { ok: false, reason: 'dns_lookup_failed', message: `"${hostname}" resolved to no addresses.` }
  }

  const addresses = records.map((r) => r.address)
  const blocked = addresses.find((addr) => isBlockedIp(addr))
  if (blocked) {
    return { ok: false, reason: 'blocked_address', message: `"${hostname}" resolves to "${blocked}", a loopback/link-local/private address.` }
  }
  return { ok: true, hostname, addresses }
}

/** Throwing wrapper around checkSsrf(), for a call site that wants to fail
 *  fast rather than branch on a result object. */
export async function assertSsrfSafe(rawUrl: string, opts: SsrfCheckOptions = {}): Promise<void> {
  const result = await checkSsrf(rawUrl, opts)
  if (!result.ok) {
    throw new UntrustedCallError(result.message, 'blocked')
  }
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

/**
 * Race `promise` against a `ms`-millisecond timer. This is the same shape as
 * the LOCAL (unexported) `withTimeout` already inside lib/mcp/client.ts —
 * that one stays private to lib/mcp and throws McpError; this is the generic,
 * exported version for any other untrusted-call call site (fetch-based ones
 * in lib/ats-apply, lib/sources) that wants the same bound without importing
 * MCP-specific error types. Does not cancel `promise` itself — the caller's
 * own AbortController (already the pattern in lib/ats/http.ts,
 * lib/kb/connectors/url.ts) is what actually stops the underlying work; this
 * only stops the CALLER from waiting on it any longer.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UntrustedCallError(`${label} timed out after ${ms}ms`, 'timeout')), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Response size cap
// ---------------------------------------------------------------------------

/** 5MB — plenty for JSON/HTML from a job board or MCP tool result, cheap to
 *  hold in memory once. Matches the order of magnitude of the existing
 *  per-purpose caps (lib/kb/connectors/url.ts's MAX_BODY_BYTES is 3MB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000

/**
 * Read a fetch Response body while enforcing a hard byte cap, so an
 * untrusted host cannot make Cello buffer an unbounded response into memory.
 * A `content-length` header is checked first as a fast fail, but a server
 * can lie about or omit it (chunked transfer has none at all), so the real
 * enforcement is the streaming read below, which aborts and cancels the
 * underlying stream the moment actual bytes exceed `maxBytes` regardless of
 * what any header claimed.
 */
export async function readLimitedBody(response: Response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared) {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new UntrustedCallError(`response declared ${n} bytes, over the ${maxBytes}-byte cap`, 'too_large')
    }
  }

  if (!response.body) {
    const buf = await response.arrayBuffer()
    if (buf.byteLength > maxBytes) {
      throw new UntrustedCallError(`response body exceeded the ${maxBytes}-byte cap`, 'too_large')
    }
    return new Uint8Array(buf)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new UntrustedCallError(`response body exceeded the ${maxBytes}-byte cap`, 'too_large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Convenience wrapper over readLimitedBody() for the common "I just want the
 *  text" case (a JSON API, an MCP HTTP response). */
export async function readLimitedText(response: Response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<string> {
  const bytes = await readLimitedBody(response, maxBytes)
  return new TextDecoder('utf-8').decode(bytes)
}

// ---------------------------------------------------------------------------
// Tool-name namespacing/validation
// ---------------------------------------------------------------------------
//
// lib/harness/copilot-tool-catalog.ts ALREADY implements the concrete case
// this generalizes: MCP_TOOL_PREFIX = 'mcp:', mcpToolName()/isMcpToolName()/
// parseMcpToolName() namespace every remote tool as `mcp:<server>:<tool>`, so
// a remote server's self-reported tool name (e.g. "list_jobs", chosen to
// match a real built-in on purpose) can never collide with the built-in of
// the same name — the qualified name always carries the "mcp:" prefix no
// built-in tool name uses. That existing mechanism is not duplicated here.
//
// What follows is the GENERIC version of that same pattern, for any FUTURE
// untrusted tool provider Cello adds (a second BYO-integration point beyond
// MCP) that needs the identical guarantee without re-deriving it. The safety
// property is structural, not a blocklist: as long as no built-in tool name
// starts with `prefix`, a namespaced name built by namespaceToolName() can
// never equal one, no matter what the untrusted provider calls its tool.

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Same identifier shape lib/mcp/registry.ts's NAME_RE already enforces for
 *  server names (which double as MCP's namespace token) — repeated here so
 *  this module has no import dependency on lib/mcp. */
export function isValidProviderId(id: string): boolean {
  return typeof id === 'string' && PROVIDER_ID_RE.test(id)
}

/**
 * Build `${prefix}${providerId}:${rawToolName}`. Throws on an invalid
 * `providerId` or empty `rawToolName` rather than silently producing a
 * malformed name — a namespace primitive that can fail open on bad input
 * would defeat the point of it.
 */
export function namespaceToolName(prefix: string, providerId: string, rawToolName: string): string {
  if (!prefix) throw new Error('untrusted: namespaceToolName requires a non-empty prefix')
  if (!isValidProviderId(providerId)) {
    throw new Error(`untrusted: invalid provider id "${providerId}" — must be 1-64 chars of letters/digits/"_"/"-"`)
  }
  const toolName = rawToolName.trim()
  if (!toolName) throw new Error('untrusted: raw tool name must be non-empty')
  return `${prefix}${providerId}:${toolName}`
}

/** True for any name carrying the given namespace prefix — a NAMING check
 *  only, same contract as isMcpToolName: it says nothing about whether the
 *  provider/tool it names actually exists. */
export function isNamespacedToolName(name: string, prefix: string): boolean {
  return typeof name === 'string' && prefix.length > 0 && name.length > prefix.length && name.startsWith(prefix)
}

/**
 * Defense in depth for the catalog side, not the dispatch side: call this
 * once (a test is the natural place — see this module's own test file)
 * against your full built-in tool list and every namespace prefix in use, so
 * a built-in tool added later can never be named in a way that starts with a
 * reserved prefix and defeats the structural guarantee above.
 */
export function assertNoPrefixCollision(builtinToolNames: readonly string[], prefix: string): void {
  const collisions = builtinToolNames.filter((n) => n.startsWith(prefix))
  if (collisions.length > 0) {
    throw new Error(
      `untrusted: built-in tool name(s) [${collisions.join(', ')}] start with reserved namespace prefix ` +
        `"${prefix}" — rename the built-in or change the prefix before an untrusted provider's namespaced ` +
        `name could be mistaken for one of these.`
    )
  }
}
