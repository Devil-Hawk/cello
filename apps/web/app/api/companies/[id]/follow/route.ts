// POST /api/companies/[id]/follow: { follow?: boolean, pin?: boolean }. Follow or stop following a
// company, and pin or unpin it (at most 5 pins). The person's session is the only door; the database
// function companies_follow is the only writer of the flag, so no agent, Gmail read or MCP call
// follows a company for anyone.

import { NextRequest, NextResponse } from 'next/server'
import { followCompanies } from '@/lib/companies/watchlist'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That company is gone.' }, { status: 404 })
  const body = (await request.json().catch(() => ({}))) as { follow?: unknown; pin?: unknown }
  const follow = typeof body.follow === 'boolean' ? body.follow : undefined
  const pin = typeof body.pin === 'boolean' ? body.pin : undefined
  if (follow === undefined && pin === undefined) return NextResponse.json({ error: 'Say follow or pin.' }, { status: 400 })
  const r = await followCompanies(c.admin, c.userId, [params.id], { follow, pin })
  return r.ok ? NextResponse.json({ ok: true, changed: r.changed }) : NextResponse.json({ ok: false, error: r.sentence }, { status: 409 })
}
