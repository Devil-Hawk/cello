// GET /api/taste: the person's taste, which is what they did with roles: their last twenty
// reactions (Interested, Not for me, Applied) with the reason they gave and the role as it was
// when they reacted. Nothing else is stored about taste, so there is nothing to reword or delete
// here: undoing a reaction is how a person takes it back. Read with the person's own session, so
// the database's row rules decide what comes back.

import { NextResponse } from 'next/server'
import type { AdminClient } from '@/lib/harness/types'
import { createClient } from '@/lib/supabase/server'
import { TASTE_REACTIONS } from '@/lib/agents/backends'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await (supabase as unknown as AdminClient)
    .from('role_reactions')
    .select('id, reaction, reason, job_title, company_name, created_at')
    .order('created_at', { ascending: false })
    .limit(TASTE_REACTIONS)
  if (error) return NextResponse.json({ error: 'Could not load your taste', fix: 'Try again in a moment.' }, { status: 500 })
  return NextResponse.json({ reactions: data ?? [] })
}
