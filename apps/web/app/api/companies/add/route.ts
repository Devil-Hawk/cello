import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { addCompany, type AddBy, type AddFailure } from '@/lib/companies/add-link'

// POST /api/companies/add   { employerId } | { candidateId } | { link }
//
// Follows an employer the directory has verified, checks a candidate the person chose, or reads a pasted careers
// link and verifies whose it is (lib/companies/add-link.ts). A check that ends in a reason is an answer, not an
// error: it is 200 with ok:false, the reason, one plain line and what Cello found that can be used instead.
//
// ponytail: only adds that succeed count toward the daily limit; add an attempts count if checks are abused.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const STATUS: Partial<Record<AddFailure, number>> = { demo: 403, daily_limit: 429, bad_link: 400, not_found: 404, not_saved: 500 }

function parseBody(body: unknown): AddBy | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const given = (['employerId', 'candidateId', 'link'] as const).filter((k) => typeof b[k] === 'string' && (b[k] as string).trim() !== '')
  if (given.length !== 1) return null
  const key = given[0]
  const value = (b[key] as string).trim()
  if (key === 'link') return value.length <= 2000 ? { link: value } : null
  return /^[0-9a-f-]{36}$/i.test(value) ? ({ [key]: value } as AddBy) : null
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const by = parseBody(await request.json().catch(() => null))
  if (!by) return NextResponse.json({ error: 'Send one of employerId, candidateId or link.' }, { status: 400 })

  try {
    const result = await addCompany(createAdminClient(), user.id, by)
    if (result.ok) return NextResponse.json(result)
    return NextResponse.json(result, { status: STATUS[result.reason] ?? 200 })
  } catch {
    return NextResponse.json({ error: 'Could not add that employer right now.' }, { status: 500 })
  }
}
