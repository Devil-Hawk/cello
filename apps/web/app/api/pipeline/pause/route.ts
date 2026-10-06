// POST /api/pipeline/pause: Pause Cello. Nothing is prepared or sent while it is on. { resume: true } turns it off.
// From the person's session, or from the extension's own token (Pause is its stop button; only the
// session may resume, so a stolen token can stop work but never restart it).

import { NextRequest, NextResponse } from 'next/server'
import { fillAuth, isFillAuth } from '@/lib/fill/auth'
import { pauseCello, resumeCello } from '@/lib/pipeline/commands'
import { isCtx, sessionCtx } from '@/lib/pipeline/session'
import { pause } from '@/lib/pipeline/transition'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { resume?: unknown; paused?: unknown }
  // the extension says { paused: true | false }, the app says { resume: true }
  const resuming = body.resume === true || body.paused === false

  if (request.headers.get('authorization')) {
    if (resuming) return NextResponse.json({ error: 'Resume Cello from the app.' }, { status: 403 })
    const a = await fillAuth(request)
    if (!isFillAuth(a)) return a
    const r = await pause(a.admin, a.userId)
    return NextResponse.json({ ok: r.ok, paused: true, already: r.already })
  }

  const c = await sessionCtx()
  if (!isCtx(c)) return c
  const r = resuming ? await resumeCello(c) : await pauseCello(c)
  return NextResponse.json({ ok: r.ok, paused: !resuming, already: r.already })
}
