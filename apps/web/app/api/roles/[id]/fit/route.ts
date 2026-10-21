// GET /api/roles/:id/fit   what Cello judged about this role for this person: the band, one reading per requirement with its
// resume line and quote, and where the reading came from. Judging itself is POST /api/roles/:id/judge.
//
// ponytail: thin until the record route of roles/page-data takes this over.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'That role id is not valid.' }, { status: 400 })
  const { data } = await createAdminClient().from('person_roles').select('band, readings, prov, judged_at').eq('user_id', user.id).eq('job_id', params.id).maybeSingle()
  if (!data) return NextResponse.json({ error: 'Role not found' }, { status: 404 })
  const { band, readings, prov, judged_at } = data as Record<string, unknown>
  return NextResponse.json({ band, readings, prov, judgedAt: judged_at })
}
