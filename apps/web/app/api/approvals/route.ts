// GET /api/approvals?status=pending: the Needs you list. Each item is an approval with a preview
// of the words it would send. Changes arrive live through Realtime on the `approvals` table
// (filtered by user_id); this route is the first load and the fallback.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { listApprovals } from '@/lib/agents/api'

export const dynamic = 'force-dynamic'

const STATUSES = ['pending', 'executing', 'done', 'failed', 'skipped', 'all'] as const

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = request.nextUrl.searchParams.get('status') ?? 'pending'
  if (!(STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: 'status must be one of ' + STATUSES.join(', ') }, { status: 400 })
  const approvals = await listApprovals(createAdminClient(), user.id, status as (typeof STATUSES)[number])
  return NextResponse.json({ approvals })
}
