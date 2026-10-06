// ponytail: the old address, for the pipeline dialogs that are not this lane's. See ../route.ts.
import { NextRequest, NextResponse } from 'next/server'
import { DELETE as deleteAttempt, PATCH as patchAttempt } from '../../attempts/[id]/route'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

export async function PATCH(request: NextRequest, ctx: Ctx) {
  const res = await patchAttempt(request, ctx)
  const { attempt, ...rest } = await res.json()
  return NextResponse.json({ ...rest, ...(attempt !== undefined && { receipt: attempt }) }, { status: res.status })
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  return deleteAttempt(request, ctx)
}
