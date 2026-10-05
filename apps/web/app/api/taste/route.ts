// GET /api/taste: the person's taste, a short list of statements about what they like and rule
// out ("prefers small teams that ship weekly"), each with the quotes it came from. Read with the
// person's own session, so the database's row rules decide what comes back.

import { NextResponse } from 'next/server'
import type { AdminClient } from '@/lib/harness/types'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // taste_statements is not in the generated types (the harness convention for newer tables).
  const { data, error } = await (supabase as unknown as AdminClient)
    .from('taste_statements')
    .select('id, statement, evidence, source, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return NextResponse.json({ error: 'Could not load your taste', fix: 'Try again in a moment.' }, { status: 500 })
  return NextResponse.json({ statements: data ?? [] })
}
