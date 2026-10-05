// GET /api/ingestion/status: when "Find new roles" last checked the signed-in
// user's companies, what it found and which companies it could not read. Read
// under the user's own session, so row level security scopes it to their rows.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { readFindNewRoles } from '@/lib/ingest/status'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  try {
    return NextResponse.json(await readFindNewRoles(supabase), { headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'Could not read the last check' }, { status: 500, headers: NO_STORE })
  }
}
