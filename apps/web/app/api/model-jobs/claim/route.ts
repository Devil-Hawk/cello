// POST /api/model-jobs/claim  { rung: 'R1' | 'R2', wait?: 0..25 }
//
// A carrier asks for one model job of its own person at its own rung. The page
// carrier (session) is told about new jobs over Realtime and claims once per
// announcement; the extension (relay token) claims inside its five minute alarm and
// may ask the server to hold the request up to 25 seconds, once, so a job queued in
// that window is not missed. Never a loop on either side.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { authorizeRelay, NO_STORE } from '@/lib/relay/auth'
import { CLAIM_WAIT_MAX_S, RELAY_RUNGS } from '@/lib/relay/protocol'
import { claimJob } from '@/lib/relay/queue'
import { waitForInsert } from '@/lib/relay/wait'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const Body = z.object({
  rung: z.enum(RELAY_RUNGS),
  wait: z.number().int().min(0).max(CLAIM_WAIT_MAX_S).optional(),
})

export async function POST(request: NextRequest) {
  const auth = await authorizeRelay(request)
  if (!auth.ok) return auth.response

  const body = Body.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return NextResponse.json({ error: 'Send a rung (R1 or R2) and, optionally, how long to wait.' }, { status: 400, headers: NO_STORE })
  }
  const { rung, wait = 0 } = body.data

  try {
    let job = await claimJob(auth.admin, auth.userId, rung)
    if (!job && wait > 0) {
      await waitForInsert(auth.admin, auth.userId, wait * 1000)
      job = await claimJob(auth.admin, auth.userId, rung)
    }
    return NextResponse.json({ job }, { headers: NO_STORE })
  } catch (err) {
    console.error('[model-jobs/claim] failed', err)
    return NextResponse.json({ error: "Couldn't check for model jobs." }, { status: 500, headers: NO_STORE })
  }
}
