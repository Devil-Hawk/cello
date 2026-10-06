// GET /api/ops/health: the latest health report, for the person who runs this
// deployment. Everyone else, signed in or not, gets a 404, so the route says
// nothing about what exists.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isOpsOwner } from '@/lib/quality/ops-owner'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isOpsOwner(user.id)) return new NextResponse(null, { status: 404 })

  const { data, error } = await createAdminClient()
    .from('ops_health_checks')
    .select('report')
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not read the health report' }, { status: 500 })

  return NextResponse.json({ report: data?.report ?? null })
}
