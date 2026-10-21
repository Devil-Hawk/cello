import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { findEmployer, realFindDeps } from '@/lib/companies/find'
import { ndjson } from '@/lib/companies/ndjson'

// POST /api/companies/find   { name }
//
// Looks for an employer by its name (lib/companies/find.ts) and streams the search as it goes: one line per rung as it
// starts, {"rung","line"}, then one last line, {"candidates":[...]} or {"none":true,"line"}. A search writes nothing
// about an employer; choosing a candidate is POST /api/companies/add. A demo account may search.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (isCrossSiteRequest(request.headers)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (name.length < 2 || name.length > 120) return NextResponse.json({ error: 'Send a name of 2 to 120 characters.' }, { status: 400 })

  const db = createAdminClient()
  return ndjson(async (emit) => emit(await findEmployer(db, user.id, name, realFindDeps(db, user.id), emit)))
}
