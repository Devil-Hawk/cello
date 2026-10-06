// POST /api/mcp, Cello as an MCP server: the same 18 first-party copilot
// tools (lib/harness/copilot-tool-catalog.ts's COPILOT_TOOLS, the registry
// dispatchTool switches on), reachable by any MCP host, behind the same
// guards the copilot's own graph enforces before it ever runs one.
//
// AUTH: a bearer api_tokens PAT (lib/access/tokens.ts), not a cookie session —
// no browser is involved. Requires the 'mcp' scope. A token whose owner has
// since become a demo profile is refused here too (binding ruling 5, class
// (a): "route-level is_demo refusal") — token ISSUE already refuses is_demo
// (app/api/settings/tokens POST) and the migration's forbid_demo_api_tokens
// trigger backstops any write that skips that route, but neither of those
// catches a token minted while the account was real and used AFTER it turned
// into (or was converted to) a demo — so USE time gets its own check, the
// same "expiry/eligibility evaluated at use time, not just at mint time"
// discipline lib/harness/keys.ts's header already states for demo key loads.
//
// THE TOOLS ARE REGISTRY COMMANDS: this route builds no tool logic of its own.
// It serves mcpView() (lib/commands/views.ts): the commands the assistant door
// may call, plus today's 18 first-party copilot tools under their old names
// (lib/commands/defs/legacy-mcp.ts, Q6), so hosts that already use them keep
// working. Every call runs through runCommand with an assistant-door context,
// so the door, the limits and the output check apply here exactly as they do
// for Chat. A legacy tool still reaches the SAME dispatchTool() every copilot
// turn calls, so trigger_run reaches invokeGraphForUser (binding ruling 7)
// exactly the way it always did, through lib/graph/invoke.ts, the ONE call site
// (lib/graph/graph-chokepoints.test.ts scan (b): this file imports no
// graph-definition module and calls neither .invoke( nor .stream( itself).
//
// EXCLUDES mcp:<server>:<tool> (the user's OWN configured MCP servers,
// lib/mcp/*): COPILOT_TOOLS never contains one (they are dispatched
// separately, by name-prefix, inside dispatchTool — see
// lib/harness/copilot-tools.ts#dispatchMcpTool), so simply never registering
// anything outside COPILOT_TOOLS already excludes them; nothing extra to
// filter here. Re-exposing them through THIS surface would let an MCP host
// use Cello as an open relay onto whatever third-party server the user
// configured — an SSRF/confused-deputy shape lib/security/untrusted.ts's
// header already names as the reason lib/mcp's own guards exist; that
// boundary would be pointless to build only to hand a bridge around it here.
//
// SUBMIT/SEND GUARD, UNCONDITIONAL, EVERY CALL, NO HUMAN-CONFIRM CHANNEL (it now
// runs inside each legacy command, in lib/commands/defs/legacy-mcp.ts; no command
// that sends is ever listed here, because mcpView drops every sends command):
// lib/graph/copilot.ts's dispatchExecute node runs the model, sees a proposed
// tool call, and — for anything submitOrSendReason() flags — PAUSES at
// interrupt() so a human can click confirm. MCP has no such channel: nobody
// is watching this connection render a confirmation UI. So the only honest
// behavior is refusal, not a pause that can never be answered — every guarded
// tool call gets a CallToolResult with isError:true and a message pointing
// back at the web UI, and dispatchTool is never reached for it. This is the
// same non-negotiable "never sends/submits anything you have not read" the
// spec states for A2A's guarded tools, implemented the same way: refuse, do
// not silently downgrade to auto-approved.
//
// STATELESS TRANSPORT — WHY, AND WHY IT MATTERS HERE SPECIFICALLY:
// A fresh McpServer + WebStandardStreamableHTTPServerTransport is
// constructed, connected, used for exactly one HTTP request, and torn down —
// `sessionIdGenerator: undefined` disables the SDK's in-memory session/stream
// bookkeeping entirely. Vercel's serverless functions do not pin a
// long-lived process to a client the way a persistent MCP server process
// would: two requests from the "same" MCP client can land on two different
// function instances with no shared memory, so anything the SDK's stateful
// mode would hold in-process (a session id -> transport map) would silently
// break the moment traffic crossed instances. `enableJsonResponse: true`
// additionally forces a single JSON HTTP response instead of an SSE stream,
// so `handleRequest` resolves once the whole answer is ready and this
// handler can tear the server down immediately after — no connection is left
// open past the request that opened it.

import { NextRequest, NextResponse } from 'next/server'
import { withTrace } from '@/lib/trace/spans'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { validateToken } from '@/lib/access/tokens'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { isDemoProfile } from '@/lib/access/guardrails'
import { COPILOT_TOOLS } from '@/lib/harness/copilot-tool-catalog'
import { mcpView, mcpToolName, runCommand, refusalResponse, assistantDoor, type AnyCommand, type CommandContext } from '@/lib/commands'
import { LEGACY_PREFIX } from '@/lib/commands/views'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const NO_STORE = { 'Cache-Control': 'no-store' }
const MCP_SCOPE = 'mcp'

const DEMO_CANNOT_USE_MCP = 'Demo workspaces cannot use the MCP API.'

function unauthorized(reason: string) {
  return NextResponse.json({ error: reason }, { status: 401, headers: NO_STORE })
}

function bearerFromRequest(request: NextRequest): string | null {
  const auth = request.headers.get('authorization')
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return null
  const value = auth.slice(7).trim()
  return value || null
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** What a command's output looks like to an MCP host. A legacy tool answers
 *  {text, is_error}; any other command's output is sent as JSON. */
function toolResult(def: AnyCommand, out: unknown): CallToolResult {
  if (def.id.startsWith(LEGACY_PREFIX)) {
    const o = out as { text: string; is_error: boolean }
    return { content: [{ type: 'text', text: o.text }], isError: o.is_error }
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false }
}

function describe(def: AnyCommand): string {
  return COPILOT_TOOLS.find((t) => `${LEGACY_PREFIX}${t.name}` === def.id)?.desc ?? def.label
}

/** Builds a fresh McpServer with every command mcpView lists, registered
 *  against `ctx`: one call per POST (see the file header's STATELESS TRANSPORT
 *  note), so `ctx` never survives past the request that built it. */
function buildServer(ctx: CommandContext): McpServer {
  const server = new McpServer({ name: 'cello', version: '1.0.0' })

  for (const def of mcpView()) {
    const name = mcpToolName(def)
    // The SDK reads the shape and drops keys it does not know before our own
    // strict parse sees the arguments, so a host that sends an extra key is not
    // refused, exactly as before.
    const inputSchema = (def.input as z.ZodObject<z.ZodRawShape>).shape
    server.registerTool(name, { title: name, description: describe(def), inputSchema }, async (args): Promise<CallToolResult> => {
      try {
        return toolResult(def, await runCommand(def, ctx, args ?? {}))
      } catch (e) {
        const refusal = refusalResponse(e)
        if (refusal) return { isError: true, content: [{ type: 'text', text: refusal.body.error }] }
        // The commands' own contract is to answer, not throw: this is defense in
        // depth against a future violation of it, not the expected path.
        return { isError: true, content: [{ type: 'text', text: `Tool "${name}" failed: ${errMsg(e)}` }] }
      }
    })
  }

  return server
}

export async function POST(request: NextRequest) {
  const bearer = bearerFromRequest(request)
  if (!bearer) return unauthorized('Missing or malformed Authorization: Bearer <token> header.')

  const admin = createAdminClient()

  const validation = await validateToken(admin, bearer)
  if (!validation.ok || !validation.userId) {
    return unauthorized(
      validation.reason === 'expired'
        ? 'This access token has expired.'
        : validation.reason === 'revoked'
          ? 'This access token has been revoked.'
          : 'Invalid access token.'
    )
  }
  if (!validation.scopes?.includes(MCP_SCOPE)) {
    return unauthorized(`This access token does not have the "${MCP_SCOPE}" scope.`)
  }
  const userId = validation.userId

  // Route-level is_demo refusal (binding ruling 5, class (a)) — see the file
  // header. Fails closed on an unreadable profile, same discipline
  // lib/harness/keys.ts's applyDemoKeyGuards uses: an unprovable "not a demo"
  // must not become a working MCP session.
  const { row: profileRow, error: profileError } = await readProfileForDemoGuards(admin, userId)
  if (profileError || !profileRow) {
    console.error('[mcp] could not verify the token owner is not a demo', profileError)
    return NextResponse.json({ error: "We couldn't verify this account." }, { status: 403, headers: NO_STORE })
  }
  // isDemoProfile only reads is_demo/demo_expires_at (id is optional on its
  // own DemoProfileFacts type, for a caller that never loaded one) — passed
  // narrowly rather than the whole KeyLoaderProfileRow, whose `id` can be
  // `null` and so doesn't satisfy DemoProfileFacts' `id?: string` as-is.
  if (isDemoProfile({ is_demo: profileRow.is_demo ?? null, demo_expires_at: profileRow.demo_expires_at ?? null })) {
    return NextResponse.json({ error: DEMO_CANNOT_USE_MCP }, { status: 403, headers: NO_STORE })
  }

  const ctx = assistantDoor({ userId, signal: request.signal })

  // Construct, use, tear down — see the file header's STATELESS TRANSPORT
  // note for why this never persists past one request.
  const server = buildServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    // The owner's tool calls: each dispatchTool nests under this root (a
    // request that calls no tool makes no trace).
    return await withTrace(admin, userId, { name: 'call-mcp-tool', isDemo: false }, () => transport.handleRequest(request))
  } catch (e) {
    console.error('[mcp] request handling failed', errMsg(e))
    return NextResponse.json({ error: 'Internal MCP server error.' }, { status: 500, headers: NO_STORE })
  } finally {
    await server.close()
  }
}
