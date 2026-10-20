// GET/POST/PATCH/DELETE for the user's MCP (Model Context Protocol) servers —
// backs components/settings/mcp-tab.tsx. All CRUD goes through
// lib/mcp/registry.ts (encryption, name validation, ownership) so this file is
// thin request plumbing, matching the shape of the other /api/settings/* routes.
//
// Server rows are NEVER returned with decrypted headers — only `hasHeaders`
// (a boolean) — so a header value never round-trips to the client, same
// discipline as /api/settings/keys never returning a saved key back.
//
// Testing a server (POST ?test=<id> or ?testDraft=1) makes a REAL, live,
// timeout-bounded connection attempt (lib/mcp/client.ts testMcpServer) and
// reports exactly what happened — this is what shows "real connection status"
// in the tab, not a guess from stored state.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  toConfig,
  setToolRule,
  recordConnectionResult,
  type McpServerRow,
} from '@/lib/mcp/registry'
import { testMcpServer, isStdioAvailable, listMcpTools } from '@/lib/mcp/client'
import { classifyMcpTool, type McpTier } from '@/lib/agents/mcp-rule'
import { isDemoProfile } from '@/lib/access/guardrails'
import { McpError, isMcpTransportKind, type McpTransportKind } from '@/lib/mcp/types'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The client-safe view of a server row — never the encrypted headers blob,
 *  only whether one is set. */
function toPublicRow(row: McpServerRow) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    hasHeaders: Boolean(row.headers),
    enabled: row.enabled,
    toolRules: row.tool_rules ?? {},
    lastConnectedAt: row.last_connected_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  }
}

function isHeadersRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

/** One tool as Settings shows it. A demo gets every tier never. */
export interface McpToolView {
  name: string
  description: string
  tier: McpTier
  never: boolean
}

const TOOL_LIST_TIMEOUT_MS = 5_000

export async function GET(request: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  // --- A server's tools, live, with the rule applied. ---
  const toolsId = new URL(request.url).searchParams.get('tools')
  if (toolsId) {
    const row = await getServer(admin, user.id, toolsId)
    if (!row) return NextResponse.json({ error: 'That server was not found.' }, { status: 404 })
    const { data: profile } = await admin.from('profiles').select('is_demo, demo_expires_at').eq('id', user.id).maybeSingle()
    const isDemo = isDemoProfile(profile as { is_demo: boolean | null; demo_expires_at: string | null } | null)
    try {
      const listed = await listMcpTools(toConfig(row), { timeoutMs: TOOL_LIST_TIMEOUT_MS })
      const never = Object.keys(row.tool_rules ?? {})
      const tools: McpToolView[] = listed.map((t) => {
        const tier = classifyMcpTool({ name: t.name, readOnlyHint: t.readOnlyHint, inputSchema: t.inputSchema }, { never, isDemo })
        return { name: t.name, description: (t.description ?? '').slice(0, 300), tier, never: tier === 'never' }
      })
      return NextResponse.json({ ok: true, tools })
    } catch {
      // Plain words only: the raw error can name the address or echo a header.
      return NextResponse.json({ ok: false, error: `Could not reach ${row.name}. Check the address and try again.` })
    }
  }

  const rows = await listServers(admin, user.id)
  return NextResponse.json({
    servers: rows.map(toPublicRow),
    stdioAvailable: isStdioAvailable(),
  })
}

export async function POST(request: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { searchParams } = new URL(request.url)
  const testId = searchParams.get('test')
  const testDraft = searchParams.get('testDraft') === '1'

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  // --- Test an already-saved server (live connection, updates last_error). ---
  if (testId) {
    const row = await getServer(admin, user.id, testId)
    if (!row) return NextResponse.json({ error: 'Server not found' }, { status: 404 })
    const result = await testMcpServer(toConfig(row))
    await recordConnectionResult(admin, row.id, result.ok ? { ok: true } : { ok: false, error: result.error })
    return NextResponse.json(result)
  }

  // --- Test an unsaved draft (no DB row yet — "Test" before "Save"). ---
  if (testDraft) {
    const transport = body.transport
    if (!isMcpTransportKind(transport)) return NextResponse.json({ error: 'Unknown transport' }, { status: 400 })
    const headers = body.headers !== undefined ? body.headers : {}
    if (!isHeadersRecord(headers)) return NextResponse.json({ error: 'headers must be a string->string object' }, { status: 400 })
    const result = await testMcpServer({
      id: 'draft',
      name: typeof body.name === 'string' ? body.name : 'draft',
      transport,
      url: typeof body.url === 'string' ? body.url : null,
      headers,
      enabled: true,
    })
    return NextResponse.json(result)
  }

  // --- Create. ---
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const transport = body.transport
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!isMcpTransportKind(transport)) return NextResponse.json({ error: 'transport must be http, sse, or stdio' }, { status: 400 })
  if (transport === 'stdio' && !isStdioAvailable()) {
    return NextResponse.json(
      { error: 'stdio servers only work in a self-hosted deployment — this instance is running on serverless.' },
      { status: 400 }
    )
  }
  const headers = body.headers !== undefined ? body.headers : {}
  if (!isHeadersRecord(headers)) return NextResponse.json({ error: 'headers must be a string->string object' }, { status: 400 })

  try {
    const row = await createServer(admin, user.id, {
      name,
      transport: transport as McpTransportKind,
      url: typeof body.url === 'string' ? body.url : null,
      headers,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
    })
    return NextResponse.json({ server: toPublicRow(row) })
  } catch (e) {
    const status = e instanceof McpError ? 400 : 500
    return NextResponse.json({ error: errMsg(e) }, { status })
  }
}

export async function PATCH(request: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const admin = createAdminClient()

  // --- Mark a tool Never, or clear the mark. ---
  if (body.tool !== undefined) {
    if (typeof body.tool !== 'string' || body.tool.length < 1 || body.tool.length > 80 || typeof body.never !== 'boolean') {
      return NextResponse.json({ error: 'tool must be 1 to 80 characters and never must be true or false' }, { status: 400 })
    }
    try {
      const row = await setToolRule(admin, user.id, id, body.tool, body.never)
      if (!row) return NextResponse.json({ error: 'That server was not found.' }, { status: 404 })
      return NextResponse.json({ server: toPublicRow(row) })
    } catch (e) {
      return NextResponse.json({ error: errMsg(e) }, { status: 500 })
    }
  }

  if (body.transport !== undefined && !isMcpTransportKind(body.transport)) {
    return NextResponse.json({ error: 'transport must be http, sse, or stdio' }, { status: 400 })
  }
  if (body.transport === 'stdio' && !isStdioAvailable()) {
    return NextResponse.json(
      { error: 'stdio servers only work in a self-hosted deployment — this instance is running on serverless.' },
      { status: 400 }
    )
  }
  if (body.headers !== undefined && !isHeadersRecord(body.headers)) {
    return NextResponse.json({ error: 'headers must be a string->string object' }, { status: 400 })
  }

  try {
    const row = await updateServer(admin, user.id, id, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.transport !== undefined ? { transport: body.transport as McpTransportKind } : {}),
      ...(body.url !== undefined ? { url: body.url as string | null } : {}),
      ...(body.headers !== undefined ? { headers: body.headers as Record<string, string> } : {}),
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    })
    return NextResponse.json({ server: toPublicRow(row) })
  } catch (e) {
    const status = e instanceof McpError ? 400 : 500
    return NextResponse.json({ error: errMsg(e) }, { status })
  }
}

export async function DELETE(request: NextRequest) {
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const admin = createAdminClient()
  try {
    await deleteServer(admin, user.id, id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 })
  }
}
