// POST /api/needs-you/[id]: press a row's button when the button is a command (a row whose button opens a
// page has nothing to run here). The id is the row's own, as GET /api/needs-you gives it; the row is read
// again first, so a button pressed on a row that has gone does nothing.

import { NextRequest, NextResponse } from 'next/server'
import { confirmFound } from '@/lib/applications/found'
import { loadNeedsYou } from '@/lib/needs-you'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const list = await loadNeedsYou(c.admin, c.userId)
  const row = list.rows.find((r) => r.id === decodeURIComponent(params.id))
  if (!row) return NextResponse.json({ error: 'That is no longer waiting on you.' }, { status: 404 })
  if (row.button.command === 'applications.confirm_found') {
    const a = (row.button.args ?? {}) as { applicationId?: string; messageId?: string }
    const r = await confirmFound(c.admin, c.userId, { applicationId: a.applicationId ?? null, messageId: a.messageId ?? null })
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: r.sentence }, { status: 409 })
  }
  return NextResponse.json({ error: 'This one opens a page.', open: row.button.command }, { status: 400 })
}
