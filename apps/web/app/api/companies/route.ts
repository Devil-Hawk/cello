import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { companiesPage, searchCompanies } from '@/lib/companies'
import { ROLE_TYPE_IDS } from '@/lib/jobs/role-types'

// GET /api/companies   the wall: { header, rows } for the signed-in person (?type, ?show_closed, ?limit, ?offset)
// GET /api/companies?q=retell   verified employers by name, domain or board token, and "Not checked yet" candidates
//
// A candidate is never listed and never counted; a failed one is never shown. The directory holds public facts only,
// so it is read with the service role once the caller is known to be signed in.

export const dynamic = 'force-dynamic'

// An absent or empty value is the fallback (Number(null) is 0, which would turn a bare request into a page of one).
const int = (v: string | null, fallback: number, max: number, min = 0) => {
  if (v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.max(Math.min(Math.floor(n), max), min) : fallback
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = new URL(request.url).searchParams
  const q = params.get('q')
  if (q !== null && q.length > 120) return NextResponse.json({ error: 'Search with at most 120 characters.' }, { status: 400 })
  const type = params.get('type') || undefined
  if (type !== undefined && !ROLE_TYPE_IDS.includes(type)) return NextResponse.json({ error: 'That is not a role type.' }, { status: 400 })

  const admin = createAdminClient()
  try {
    if (q !== null) return NextResponse.json({ ok: true, query: q.trim(), ...(await searchCompanies(admin, q)) })
    const page = await companiesPage(admin, user.id, {
      type,
      showClosed: ['1', 'true'].includes(params.get('show_closed') ?? ''),
      limit: int(params.get('limit'), 50, 100, 1),
      offset: int(params.get('offset'), 0, 100_000),
    })
    return NextResponse.json({ ok: true, ...page })
  } catch {
    return NextResponse.json({ error: 'Could not read the employers right now.' }, { status: 500 })
  }
}
