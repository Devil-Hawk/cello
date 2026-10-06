// POST /api/answers/facts: { authorized: boolean, needsSponsorship: boolean }. The two facts the
// person gives once. Code maps the work-authorization and sponsorship wordings it knows to them;
// every other wording stays an open question for the person.

import { NextRequest, NextResponse } from 'next/server'
import { saveWorkFacts } from '@/lib/answers'
import { writerCtx } from '@/lib/answers/session'
import { isCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const c = await writerCtx()
  if (!isCtx(c)) return c
  const b = (await request.json().catch(() => null)) as { authorized?: unknown; needsSponsorship?: unknown } | null
  if (typeof b?.authorized !== 'boolean' || typeof b?.needsSponsorship !== 'boolean') {
    return NextResponse.json({ error: 'Say whether you may work here and whether you need sponsorship.' }, { status: 400 })
  }
  const r = await saveWorkFacts(c.admin, c.userId, { authorized: b.authorized, needsSponsorship: b.needsSponsorship })
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: r.sentence }, { status: 500 })
}
