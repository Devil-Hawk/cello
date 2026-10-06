// PATCH /api/answers/[id]: the person edits a saved answer ({ answer } or { declined }).
// POST /api/answers/[id]: the person answers an open question ({ answer } or { declined }), or
// confirms what Cello saved from Chat ({ confirm: true }). Either way every application waiting on it
// moves on. Only the person's session writes; Chat's words stay a proposal until the person confirms.

import { NextRequest, NextResponse } from 'next/server'
import { answerArrived, confirmAnswer, saveAnswer } from '@/lib/answers'
import { UUID, writerCtx } from '@/lib/answers/session'
import { isCtx } from '@/lib/pipeline/session'

export const dynamic = 'force-dynamic'

async function read(request: NextRequest): Promise<{ answer?: unknown; declined?: boolean; confirm?: boolean } | null> {
  const b = await request.json().catch(() => null)
  if (!b || typeof b !== 'object') return null
  const o = b as Record<string, unknown>
  return { answer: o.answer, declined: typeof o.declined === 'boolean' ? o.declined : undefined, confirm: o.confirm === true }
}

async function handle(request: NextRequest, id: string, resume: boolean): Promise<NextResponse> {
  const c = await writerCtx()
  if (!isCtx(c)) return c
  if (!UUID.test(id)) return NextResponse.json({ error: 'That question is gone.' }, { status: 404 })
  const body = await read(request)
  if (!body) return NextResponse.json({ error: 'Send JSON.' }, { status: 400 })
  const r = body.confirm && resume ? await confirmAnswer(c.admin, c.userId, id) : await saveAnswer(c.admin, c.userId, id, body)
  if (!r.ok) return NextResponse.json({ ok: false, error: r.sentence }, { status: r.sentence === 'That question is gone.' ? 404 : 400 })
  const { moved } = resume ? await answerArrived(c.admin, c.userId, id) : { moved: 0 }
  return NextResponse.json({ ok: true, moved })
}

export const PATCH = (request: NextRequest, { params }: { params: { id: string } }) => handle(request, params.id, false)
export const POST = (request: NextRequest, { params }: { params: { id: string } }) => handle(request, params.id, true)
