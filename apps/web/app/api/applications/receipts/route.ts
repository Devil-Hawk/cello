// ponytail: the old address, for the pipeline dialogs that are not this lane's. They read `receipts`
// and `receipt` from the answer, so this runs the new route and renames those two keys; a plain
// redirect would hand them a body they cannot read. PG5 moves the dialogs to /api/applications/attempts
// and deletes this file. The retired-word scan allows it.
import { NextRequest, NextResponse } from 'next/server'
import { GET as getAttempts, POST as postAttempt } from '../attempts/route'

export const dynamic = 'force-dynamic'

async function oldNames(res: NextResponse): Promise<NextResponse> {
  const { attempts, attempt, ...rest } = await res.json()
  const body = { ...rest, ...(attempts !== undefined && { receipts: attempts }), ...(attempt !== undefined && { receipt: attempt }) }
  return NextResponse.json(body, { status: res.status })
}

export async function GET(request: NextRequest) {
  return oldNames(await getAttempts(request))
}

export async function POST(request: NextRequest) {
  return oldNames(await postAttempt(request))
}
