// POST   /api/roles/:id/reaction { reaction, reason?, note?, surface, pickKind? }   Interested, Not for me or Applied.
// DELETE /api/roles/:id/reaction                                                    takes it back.
//
// Runs as the signed-in person, so the database's own row level security stands
// behind every write here. Learning from the reaction happens the next time roles
// are assessed; nothing slow is done in this request.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { PASS_REASONS, triageRole, undoReaction } from '@/lib/scoring'
import { scoringErrorResponse } from '@/lib/scoring/http'

export const dynamic = 'force-dynamic'

const Body = z.object({
  reaction: z.enum(['interested', 'not_for_me', 'applied']),
  reason: z.enum(PASS_REASONS).nullish(),
  note: z.string().max(500).nullish(),
  surface: z.enum(['today', 'opportunities', 'chat', 'pipeline']),
  pickKind: z.enum(['top', 'explore']).nullish(),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: { id: string } }

export async function POST(request: NextRequest, { params }: Ctx) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'That reaction is not valid.' }, { status: 400 })
  const b = parsed.data
  try {
    const out = await triageRole({ db: supabase, userId: user.id, jobId: params.id, reaction: b.reaction, reason: b.reason ?? null, note: b.note ?? null, surface: b.surface, pickKind: b.pickKind ?? null })
    return NextResponse.json(out)
  } catch (err) {
    return scoringErrorResponse(err, {})
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })
  try {
    return NextResponse.json(await undoReaction({ db: supabase, userId: user.id, jobId: params.id }))
  } catch (err) {
    return scoringErrorResponse(err, {})
  }
}
