import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/harness/supabase-admin'
import { directoryProgress, listCompanies, searchCompanies, LIST_PAGE } from '@/lib/companies/directory'

// GET /api/companies            the verified employers, a page at a time (?limit, ?offset)
// GET /api/companies?q=retell   verified employers by name, domain or board token, and "Not checked yet" candidates
//
// A candidate is never listed and never counted; a failed one is never shown. The directory holds public facts only,
// so it is read with the service role once the caller is known to be signed in.

export const dynamic = 'force-dynamic'

const int = (v: string | null, fallback: number, max: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const params = new URL(request.url).searchParams
  const admin = createAdminClient()
  try {
    const q = params.get('q')
    if (q !== null) return NextResponse.json({ ok: true, query: q.trim(), ...(await searchCompanies(admin, q)) })
    const limit = int(params.get('limit'), LIST_PAGE, 100)
    const offset = int(params.get('offset'), 0, 100_000)
    const employers = await listCompanies(admin, { limit, offset })
    // Until the seed is checked the page says how far it has come ("Cello has checked 1,200 employers so far").
    return NextResponse.json({ ok: true, employers, limit, offset, progress: await directoryProgress(admin) })
  } catch {
    return NextResponse.json({ error: 'Could not read the employers right now.' }, { status: 500 })
  }
}
