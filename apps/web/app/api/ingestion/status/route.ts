// GET /api/ingestion/status: when "Find new roles" last checked the signed-in
// user's companies, what it found and which companies it could not read. Read
// under the user's own session, so row level security scopes it to their rows.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { checksStatus } from '@/lib/clock/status'
import { readFindNewRoles } from '@/lib/ingest/status'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  try {
    // The clock's record: last and next check, whether background work is on, whether it is paused.
    let admin = null
    try {
      admin = createAdminClient()
    } catch {
      /* no service role on this deployment: background work reads as off */
    }
    const checks = await checksStatus(supabase, admin)
    const status = await readFindNewRoles(supabase, new Date(), checks.rolesCheck?.nextDueAt ?? null)
    return NextResponse.json({ ...status, checks }, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ error: 'Could not read the last check' }, { status: 500, headers: NO_STORE })
  }
}
