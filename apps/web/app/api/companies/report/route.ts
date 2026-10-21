import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { ADD_LINES } from '@/lib/companies/add-link'
import { reportEmployer } from '@/lib/companies/follow'

// POST /api/companies/report   { employerId }
//
// "Not this company": the person unfollows the employer, their report is kept, and the employer's board is proven again
// at the next read (lib/companies/follow.ts). Answers 200 with what the person's bookmark was, 403 for a demo account,
// 404 for an unknown employer.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UUID = /^[0-9a-f-]{36}$/i

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as { employerId?: unknown } | null
  if (typeof body?.employerId !== 'string' || !UUID.test(body.employerId)) return NextResponse.json({ error: 'Send employerId.' }, { status: 400 })

  try {
    const result = await reportEmployer(createAdminClient(), user.id, body.employerId)
    if (result.ok) return NextResponse.json(result)
    return NextResponse.json({ error: ADD_LINES[result.reason] }, { status: result.reason === 'demo' ? 403 : 404 })
  } catch {
    return NextResponse.json({ error: 'Could not record that report right now.' }, { status: 500 })
  }
}
