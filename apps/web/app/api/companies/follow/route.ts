import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { loadPerson } from '@/lib/companies/read-employer'
import { followAndRead, unfollowEmployer, type FollowResult } from '@/lib/companies/follow'

// POST   /api/companies/follow   { employerId, dream? }  follow a verified employer and read its board inside 8 s
// DELETE /api/companies/follow   { employerId }          take the bookmark off; the row and the employer stay
//
// A follow that ends in a reason is an answer, not an error: 200 with ok:false and one plain line. A read that runs past
// the budget is 200 with the hand-off line; the read finishes on the host.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f-]{36}$/i
const STATUS: Record<Extract<FollowResult, { ok: false }>['reason'], number> = { demo: 403, daily_limit: 429, not_found: 404, not_saved: 500 }

function employerIdOf(body: unknown): string | null {
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).employerId : null
  return typeof id === 'string' && UUID.test(id) ? id : null
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  const employerId = employerIdOf(body)
  const dream = (body as { dream?: unknown } | null)?.dream
  if (!employerId || (dream !== undefined && typeof dream !== 'boolean')) return NextResponse.json({ error: 'Send employerId, and dream if you set it.' }, { status: 400 })

  try {
    const db = createAdminClient()
    const result = await followAndRead(db, user.id, employerId, await loadPerson(db, user.id), { dream: dream === true })
    if (result.ok) return NextResponse.json(result)
    return NextResponse.json(result, { status: STATUS[result.reason] })
  } catch {
    return NextResponse.json({ error: 'Could not follow that employer right now.' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const employerId = employerIdOf(await request.json().catch(() => null))
  if (!employerId) return NextResponse.json({ error: 'Send employerId.' }, { status: 400 })

  try {
    return NextResponse.json(await unfollowEmployer(createAdminClient(), user.id, employerId))
  } catch {
    return NextResponse.json({ error: 'Could not unfollow that employer right now.' }, { status: 500 })
  }
}
