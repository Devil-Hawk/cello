// POST /api/a2a — Cello's A2A endpoint: matcher, company_researcher and
// interview_prep, reachable by any A2A caller holding a PAT with the 'a2a'
// scope (lib/access/tokens.ts).
//
// TRANSPORT DECISION (spec Step 3, item 1 — see scripts/spike-a2a-roundtrip.ts
// for the executed, in-process proof this decision is built from):
//   compat/v0_3's LegacyJsonRpcTransportHandler (classic method names
//   message/send, tasks/get, tasks/cancel; classic wire JSON: role as
//   "user"/"agent", a text part as {kind:'text', text}). @a2a-js/sdk's
//   OTHER transport (`@a2a-js/sdk/server`'s JsonRpcTransportHandler) speaks
//   ts-proto's protobuf-JSON convention (role as the ROLE_USER/ROLE_AGENT
//   ENUM NAME; a text part's payload under `content:{$case:'text',value}`)
//   and — verified, not assumed — SILENTLY DROPS a classic-shaped message's
//   content with NO thrown error (case B in the proof script): `role`
//   decodes to UNRECOGNIZED, the text part decodes to nothing usable. A
//   content-forwarding endpoint cannot tolerate a 200-shaped success that
//   quietly lost the content, so compat/v0_3 is the transport, not native.
//   Proof transcript (2026-08-25, `npx tsx scripts/spike-a2a-roundtrip.ts`):
//     [A] compat + classic JSON  -> echoed="score me against the resume, please"
//     [B] native + classic JSON  -> NO ERROR, echoed="<<NOTHING SURVIVED>>"
//     [C] compat + malformed     -> LOUD ERROR code=-32602 "Invalid v0.3 part kind: bogus"
//     [D] native + native JSON   -> echoed="score me against the resume, please"
//
// AUTH: a bearer api_tokens PAT, scope 'a2a' — same shape and same
// route-level is_demo refusal (binding ruling 5, class (a)) as
// app/api/mcp/route.ts; see that route's header for why USE-time (not just
// mint-time) demo refusal is its own check.
//
// RULING 7 — NO SECOND GRAPH DOOR: this route never imports a graph
// definition module and never calls .invoke(/.stream( itself. The
// AgentExecutor it wires (lib/a2a/executor.ts) calls invokeGraphForUser for
// message/send's initial run; lib/a2a/task-store.ts calls it again for
// tasks/get's continue-if-non-terminal poll. Both go through
// lib/graph/invoke.ts, exactly like MCP's trigger_run.
//
// "IT NEVER SENDS/SUBMITS ANYTHING YOU HAVE NOT READ" — no guard needed
// HERE, unlike MCP's dispatchTool surface: the three agents A2A exposes
// (lib/a2a/agent.ts#A2A_AGENTS) have no submit-capable code path AT ALL —
// buildA2aPlan only ever emits a matcher | company_researcher |
// interview_prep step, never 'applier' — so there is no guarded tool call
// to refuse in the first place. lib/a2a/graph-shape.test.ts asserts this by
// construction.
//
// INJECTION LEDGER CLASSIFICATION: FORWARDER (lib/security/injection-
// chokepoints.test.ts), same as app/api/mcp/route.ts — every field this
// route's executor threads into a plan (jobIds/companyId/jobId) is an id,
// never free text, and it builds no prompt of its own. See lib/a2a/agent.ts's
// header for why no free-text override field exists to forward in the
// first place.

import { NextRequest, NextResponse } from 'next/server'
import { DefaultRequestHandler } from '@a2a-js/sdk/server'
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { validateToken } from '@/lib/access/tokens'
import { readProfileForDemoGuards } from '@/lib/harness/keys'
import { isDemoProfile } from '@/lib/access/guardrails'
import { buildNativeAgentCard } from '@/lib/a2a/card'
import { createA2aExecutor } from '@/lib/a2a/executor'
import { createA2aTaskStore } from '@/lib/a2a/task-store'
import { buildA2aServerCallContext } from '@/lib/a2a/context'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const NO_STORE = { 'Cache-Control': 'no-store' }
const A2A_SCOPE = 'a2a'
const DEMO_CANNOT_USE_A2A = 'Demo workspaces cannot use the A2A API.'

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
  if (!validation.scopes?.includes(A2A_SCOPE)) {
    return unauthorized(`This access token does not have the "${A2A_SCOPE}" scope.`)
  }
  const userId = validation.userId

  // Route-level is_demo refusal (binding ruling 5, class (a)) — see the
  // file header and app/api/mcp/route.ts's identical check.
  const { row: profileRow, error: profileError } = await readProfileForDemoGuards(admin, userId)
  if (profileError || !profileRow) {
    console.error('[a2a] could not verify the token owner is not a demo', profileError)
    return NextResponse.json({ error: "We couldn't verify this account." }, { status: 403, headers: NO_STORE })
  }
  if (isDemoProfile({ is_demo: profileRow.is_demo ?? null, demo_expires_at: profileRow.demo_expires_at ?? null })) {
    return NextResponse.json({ error: DEMO_CANNOT_USE_A2A }, { status: 403, headers: NO_STORE })
  }

  let body: string
  try {
    body = await request.text()
  } catch (e) {
    return NextResponse.json({ error: `Could not read request body: ${errMsg(e)}` }, { status: 400, headers: NO_STORE })
  }

  const a2aUrl = new URL('/api/a2a', request.nextUrl.origin).toString()
  const requestHandler = new DefaultRequestHandler(buildNativeAgentCard(a2aUrl), createA2aTaskStore(admin), createA2aExecutor(admin))
  const transport = new LegacyJsonRpcTransportHandler(requestHandler)
  const context = buildA2aServerCallContext(userId)

  try {
    const result = await transport.handle(body, context)
    // Never a generator in practice — the agent card declares
    // capabilities.streaming:false, and message/stream / tasks/resubscribe
    // are the only two methods LegacyJsonRpcTransportHandler.handle() ever
    // returns an AsyncGenerator for; both throw `unsupportedOperation`
    // against this card before reaching that branch. Guarded rather than
    // assumed so a future capability flip fails loudly here instead of
    // silently returning an async generator's [object Object] shape.
    if (Symbol.asyncIterator in Object(result)) {
      return NextResponse.json({ error: 'Streaming is not supported on this endpoint.' }, { status: 501, headers: NO_STORE })
    }
    // JSON-RPC responses are always HTTP 200 — errors live in the body's
    // `.error` field (JSON-RPC 2.0 convention), matching the transport's
    // own contract; only a wrapper failure (below) is a non-200.
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (e) {
    console.error('[a2a] request handling failed', errMsg(e))
    return NextResponse.json({ error: 'Internal A2A server error.' }, { status: 500, headers: NO_STORE })
  }
}
