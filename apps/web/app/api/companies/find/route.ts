import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { isCrossSiteRequest } from '@/lib/security/same-origin'
import { findEmployer, realFindDeps } from '@/lib/companies/find'
import { ndjson } from '@/lib/companies/ndjson'
import { rpcSlotStore } from '@/lib/commands/slots'

// POST /api/companies/find   { name }
//
// Looks for an employer by its name (lib/companies/find.ts) and streams the search as it goes: one line per rung as it
// starts, {"rung","line"}, then one last line, {"candidates":[...]} or {"none":true,"line"}. A search writes nothing
// about an employer; choosing a candidate is POST /api/companies/add. A demo account may search. A person may search
// FIND_LIMIT times an hour (the command slots); past that the answer is a plain 429 with a line.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FIND_LIMIT = 60

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
  // A search makes dozens of outbound requests. A limit that cannot be counted is not a limit, so a failed count refuses.
  const allowed = await rpcSlotStore(db).take({ userId: user.id, channel: 'companies', bucket: 'find', limit: FIND_LIMIT, windowSeconds: 3600 }).catch(() => null)
  if (allowed === null) return NextResponse.json({ error: 'Could not search right now. Try again.' }, { status: 503 })
  if (!allowed) return NextResponse.json({ error: 'rate_limited', line: 'You have searched a lot this hour. Try again a little later, or paste the careers link.' }, { status: 429 })
  return ndjson(async (emit) => emit(await findEmployer(db, user.id, name, realFindDeps(db, user.id), emit)))
}
