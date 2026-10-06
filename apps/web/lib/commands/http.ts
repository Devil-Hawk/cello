// For routes: turn a refusal from a door or from runCommand into the response
// the person's browser gets. Anything that is not a refusal is a failure and is
// thrown again, so Next answers 500 as it always has.

import { NextResponse } from 'next/server'
import { refusalResponse } from './run'

export function refusalToResponse(e: unknown): NextResponse {
  const r = refusalResponse(e)
  if (!r) throw e
  return NextResponse.json(r.body, { status: r.status })
}
