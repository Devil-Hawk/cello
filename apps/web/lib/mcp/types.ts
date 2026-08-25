// Types for the MCP (Model Context Protocol) BYO-server connector.
//
// A "server" here is a THIRD-PARTY process the user points Cello at (their own
// MCP server, or someone else's). We only ever act as an MCP CLIENT — nothing
// in this repo hosts an MCP server. See lib/mcp/client.ts for the connection
// code and lib/mcp/registry.ts for the per-user CRUD + prompt/dispatch glue.
//
// SAFETY: tool descriptions and tool call RESULTS that come back from a
// configured server are UNTRUSTED INPUT — third-party code the user chose to
// point at, not Cello's own instructions. Every layer that touches this data
// (registry prompt-block building, copilot-tools dispatch, the system prompt
// assembled in app/api/copilot/route.ts) must keep treating it as data, never
// as instructions that can change what the copilot is allowed to do. See the
// "SAFETY" comment block in lib/mcp/registry.ts for where this is enforced.

/**
 * 'stdio' spawns a child process — only possible on a machine you actually
 * control (see lib/mcp/client.ts isStdioAvailable()). 'http' (Streamable
 * HTTP, the current MCP spec transport) and 'sse' (the older/deprecated
 * transport some servers still speak) both work anywhere, including Vercel.
 * No CHECK constraint on the DB column for this — vocabulary lives here in TS,
 * matching kb_sources.kind / application_drafts.status.
 */
export type McpTransportKind = 'http' | 'sse' | 'stdio'

export const MCP_TRANSPORTS: readonly McpTransportKind[] = ['http', 'sse', 'stdio']

export function isMcpTransportKind(value: unknown): value is McpTransportKind {
  return typeof value === 'string' && (MCP_TRANSPORTS as readonly string[]).includes(value)
}

/** Raw row shape from user_mcp_servers (headers still ENCRYPTED — see
 *  lib/crypto.ts encrypt/decrypt; never log or return this.headers verbatim). */
export interface McpServerRow {
  id: string
  user_id: string
  name: string
  transport: McpTransportKind
  /**
   * 'http'/'sse': the server URL. 'stdio': the shell command line to spawn
   * (e.g. "npx -y @modelcontextprotocol/server-filesystem /home/me/docs") —
   * the fixed migration column set has no separate command/args columns, so
   * stdio reuses this one and lib/mcp/client.ts splits it on connect.
   */
  url: string | null
  /** AES-256-GCM ciphertext (lib/crypto.ts format) of a JSON-encoded
   *  Record<string,string> of custom headers (e.g. Authorization). NULL/empty
   *  when the server needs none. NEVER plaintext, NEVER logged. */
  headers: string | null
  enabled: boolean
  last_connected_at: string | null
  last_error: string | null
  created_at: string
}

/** Decrypted, in-memory-only view of a server, ready to hand to lib/mcp/client.
 *  Never persisted, never sent to the client bundle, never logged. */
export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransportKind
  url: string | null
  headers: Record<string, string>
  enabled: boolean
}

/** One tool as advertised by a connected MCP server. */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  /** From the MCP tool-annotations spec (server-declared, so itself untrusted
   *  — treated as a hint for UI/prompt phrasing, never as a substitute for the
   *  copilot's own confirmation flow). */
  destructiveHint?: boolean
  readOnlyHint?: boolean
}

/** A tool namespaced for the copilot as `mcp:<server>:<tool>` (see
 *  lib/harness/copilot-tool-catalog.ts MCP_TOOL_PREFIX / isMcpToolName). */
export interface NamespacedMcpTool {
  qualifiedName: string
  serverName: string
  serverId: string
  tool: McpToolDescriptor
}

export interface McpTestResult {
  ok: boolean
  toolCount?: number
  toolNames?: string[]
  error?: string
}

/**
 * Thrown for any MCP connection/protocol failure (bad url, refused
 * connection, timeout, malformed response, unknown tool). `message` is safe
 * to show the user directly. Never carries header/credential values.
 */
export class McpError extends Error {
  readonly server?: string
  constructor(message: string, opts: { server?: string } = {}) {
    super(message)
    this.name = 'McpError'
    this.server = opts.server
  }
}
