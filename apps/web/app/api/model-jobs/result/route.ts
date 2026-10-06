// POST /api/model-jobs/result  { job_id, claim_id, text } or { job_id, claim_id, error }
//
// A carrier returns what its model said. The route checks the size (64 KB) and the
// shape, and the SQL function checks the rest in one statement: the job is this
// person's, the claim id is the one handed out, and the job is still claimed. Anything
// else, including a second answer, is refused and changes nothing. The text is not
// trusted here either: the step that asked parses it with its own schema and checks.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRelay, NO_STORE } from '@/lib/relay/auth'
import { MAX_RESULT_BYTES, ResultBody, byteLength } from '@/lib/relay/protocol'
import { completeJob } from '@/lib/relay/queue'

export const dynamic = 'force-dynamic'

// A little over the text limit: JSON escaping and the two ids ride along.
const MAX_BODY_BYTES = MAX_RESULT_BYTES * 2 + 1024

export async function POST(request: NextRequest) {
  const auth = await authorizeRelay(request)
  if (!auth.ok) return auth.response

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'That answer is too large.' }, { status: 413, headers: NO_STORE })
  }
  const raw = await request.text()
  if (byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'That answer is too large.' }, { status: 413, headers: NO_STORE })
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  const body = ResultBody.safeParse(json)
  if (!body.success) {
    return NextResponse.json({ error: 'Send the job, the claim, and either text or an error.' }, { status: 400, headers: NO_STORE })
  }
  if (body.data.text !== undefined && byteLength(body.data.text) > MAX_RESULT_BYTES) {
    return NextResponse.json({ error: 'That answer is too large.' }, { status: 413, headers: NO_STORE })
  }

  try {
    const taken = await completeJob(auth.admin, {
      userId: auth.userId,
      jobId: body.data.job_id,
      claimId: body.data.claim_id,
      text: body.data.text,
      error: body.data.error,
    })
    if (!taken) {
      return NextResponse.json({ error: 'This job is not waiting for an answer.' }, { status: 409, headers: NO_STORE })
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (err) {
    console.error('[model-jobs/result] failed', err)
    return NextResponse.json({ error: "Couldn't save that answer." }, { status: 500, headers: NO_STORE })
  }
}
