// POST /api/pipeline/pause: Pause Cello. Nothing is prepared or sent while it is on. { resume: true } turns it off.
// From the person's session. (The extension's fill token joins this route in K18.)

import { NextRequest, NextResponse } from 'next/server'
import { pauseCello, resumeCello } from '@/lib/pipeline/commands'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const body = (await request.json().catch(() => ({}))) as { resume?: unknown }
  const r = body.resume === true ? await resumeCello(c) : await pauseCello(c)
  return NextResponse.json({ ok: r.ok, paused: body.resume !== true, already: r.already })
}
