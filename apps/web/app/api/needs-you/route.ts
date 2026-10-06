// GET /api/needs-you: the one list of what waits on the person, in reading order, with the badge count.

import { NextResponse } from 'next/server'
import { loadNeedsYou } from '@/lib/needs-you'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function GET() {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  try {
    return NextResponse.json(await loadNeedsYou(c.admin, c.userId))
  } catch {
    return NextResponse.json({ error: 'Could not load what needs you. Try again.' }, { status: 500 })
  }
}
