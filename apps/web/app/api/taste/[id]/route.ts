// /api/taste/[id]
//
// PATCH  { statement }  reword one of the person's taste statements.
// DELETE                remove one. Cello stops using it from the next conversation.
//
// Both use the person's own session: the table's row rules let a person change only their own
// rows, so a statement that is not theirs answers as not found.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { AdminClient } from '@/lib/harness/types'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const NOT_FOUND = { error: 'Not found', fix: 'Open your taste and choose one from the list.' }
const Body = z.object({ statement: z.string().trim().min(1).max(200) })

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body', fix: 'Send { statement } of 1 to 200 characters.' }, { status: 400 })

  const { data } = await (supabase as unknown as AdminClient)
    .from('taste_statements')
    .update({ statement: parsed.data.statement, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('id, statement, evidence, source, created_at, updated_at')
  const row = (data ?? [])[0]
  return row ? NextResponse.json({ statement: row }) : NextResponse.json(NOT_FOUND, { status: 404 })
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await (supabase as unknown as AdminClient).from('taste_statements').delete().eq('id', params.id).select('id')
  return (data ?? []).length ? NextResponse.json({ deleted: true }) : NextResponse.json(NOT_FOUND, { status: 404 })
}
