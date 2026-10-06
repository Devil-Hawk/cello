// GET /api/applications/found: applications Cello found in your email, waiting for you to confirm.
// POST /api/applications/found: { applicationId } or { messageId } confirms one. Only the person's
// session confirms; confirming never follows a company.

import { NextRequest, NextResponse } from 'next/server'
import { confirmFound, listFound } from '@/lib/applications/found'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  return NextResponse.json({ found: await listFound(c.admin, c.userId) })
}

export async function POST(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const b = (await request.json().catch(() => null)) as { applicationId?: unknown; messageId?: unknown } | null
  const applicationId = typeof b?.applicationId === 'string' && UUID.test(b.applicationId) ? b.applicationId : null
  const messageId = typeof b?.messageId === 'string' && UUID.test(b.messageId) ? b.messageId : null
  if (!applicationId && !messageId) return NextResponse.json({ error: 'Say which one to confirm.' }, { status: 400 })
  const r = await confirmFound(c.admin, c.userId, { applicationId, messageId })
  return r.ok ? NextResponse.json({ ok: true, applicationId: r.applicationId }) : NextResponse.json({ ok: false, error: r.sentence }, { status: 409 })
}
