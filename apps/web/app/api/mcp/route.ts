// POST /api/mcp — Cello as an MCP server: the same 19 first-party copilot
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
// STATELESS, PER lib/graph/invoke.ts-STYLE SINGLE-DOOR REUSE, NOT A SECOND
// TOOL SURFACE: this route builds no tool logic of its own. It builds the
// SAME CopilotToolContext lib/graph/copilot.ts#dispatchExecute builds (admin
// client scoped by loadApiKeys — which applies the demo/spend guards a key
// load always carries — userId, userEmail, apiKeys) and calls the SAME
// dispatchTool() every copilot turn calls. trigger_run therefore reaches
// invokeGraphForUser (binding ruling 7) exactly the way it already does from
// the copilot graph — through lib/graph/invoke.ts, the ONE call site
// (lib/graph/graph-chokepoints.test.ts scan (b) — this file imports no
// graph-definition module and calls neither .invoke( nor .stream( itself, so
// it never becomes a second one).
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
// SUBMIT/SEND GUARD — UNCONDITIONAL, EVERY CALL, NO HUMAN-CONFIRM CHANNEL:
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import type { AdminClient } from '@/lib/harness/types'
import { validateToken } from '@/lib/access/tokens'
import { readProfileForDemoGuards, loadApiKeys } from '@/lib/harness/keys'
import { isDemoProfile } from '@/lib/access/guardrails'
import { dispatchTool, COPILOT_TOOLS, type CopilotToolContext } from '@/lib/harness/copilot-tools'
import { submitOrSendReason } from '@/lib/graph/copilot'
import { TOOL_SCHEMAS } from '@/lib/mcp/tool-schemas'

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

/** GoTrue's own address for this auth user, or null. Same read
 *  app/api/access/redeem/route.ts's authEmailForUser already established for
 *  the identical "no session, only a userId" situation — reused as the
 *  smallest local copy rather than exporting a one-line helper across an
 *  unrelated route for a single second caller. */
async function emailForUser(admin: AdminClient, userId: string): Promise<string> {
  const { data } = await admin.auth.admin.getUserById(userId)
  return typeof data?.user?.email === 'string' ? data.user.email : ''
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function toolResult(observation: unknown): CallToolResult {
  const text = typeof observation === 'string' ? observation : JSON.stringify(observation)
  const isError = Boolean(observation && typeof observation === 'object' && 'error' in (observation as Record<string, unknown>))
  return { content: [{ type: 'text', text }], isError }
}

/** The refusal every guarded call gets — see the file header's SUBMIT/SEND
 *  GUARD section. Points at the one place this action CAN happen: a human,
 *  in the web app, clicking confirm. */
function refusalResult(reason: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${reason} This cannot be approved over MCP — there is no human to confirm it here. Open the Cello web app and approve it from the copilot chat instead.`,
      },
    ],
  }
}

/** Builds a fresh McpServer with all 19 first-party tools registered against
 *  `ctx` — one call per POST (see the file header's STATELESS TRANSPORT
 *  note), so `ctx` (and everything it closes over) never survives past the
 *  request that built it. */
function buildServer(ctx: CopilotToolContext): McpServer {
  const server = new McpServer({ name: 'cello', version: '1.0.0' })

  for (const spec of COPILOT_TOOLS) {
    const inputSchema = TOOL_SCHEMAS[spec.name]
    if (!inputSchema) {
      // Cannot happen outside a drift between the catalog and tool-schemas.ts
      // (app/api/mcp/route.test.ts pins the two lists equal) — fails loudly
      // rather than silently registering a tool with no argument shape.
      throw new Error(`lib/mcp/tool-schemas.ts has no schema for catalog tool "${spec.name}"`)
    }
    server.registerTool(
      spec.name,
      { title: spec.name, description: spec.desc, inputSchema },
      async (args): Promise<CallToolResult> => {
        const toolArgs = (args ?? {}) as Record<string, unknown>
        try {
          // (3) UNCONDITIONAL submit/send guard — before anything else, every
          // call, no exceptions. See the file header.
          const reason = submitOrSendReason(spec.name, toolArgs)
          if (reason) return refusalResult(reason)
          // (4)/(5): no review/bypass step exists here (that is the copilot
          // graph's confirm/review interrupt, which needs a human watching a
          // UI) — an unguarded tool just runs, exactly like a copilot turn
          // with bypassMode on for read/act tools.
          const observation = await dispatchTool(ctx, spec.name, toolArgs)
          return toolResult(observation)
        } catch (e) {
          // dispatchTool's own contract is "always resolves, never throws"
          // (lib/harness/copilot-tools.ts) — this is defense in depth against
          // a future violation of that contract, not the expected path.
          return { isError: true, content: [{ type: 'text', text: `Tool "${spec.name}" failed: ${errMsg(e)}` }] }
        }
      }
    )
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

  let ctx: CopilotToolContext
  try {
    const [apiKeys, userEmail] = await Promise.all([loadApiKeys(admin, userId), emailForUser(admin, userId)])
    ctx = { admin, userId, userEmail, apiKeys, signal: request.signal }
  } catch (e) {
    console.error('[mcp] failed to build tool context', errMsg(e))
    return NextResponse.json({ error: "Couldn't set up this request." }, { status: 500, headers: NO_STORE })
  }

  // Construct, use, tear down — see the file header's STATELESS TRANSPORT
  // note for why this never persists past one request.
  const server = buildServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } catch (e) {
    console.error('[mcp] request handling failed', errMsg(e))
    return NextResponse.json({ error: 'Internal MCP server error.' }, { status: 500, headers: NO_STORE })
  } finally {
    await server.close()
  }
}
